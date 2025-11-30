
import type { MentionEvent as BaseEventMention } from '../../core/entity/type.js';
import type { GenerativeModel } from '@google/generative-ai';
import { AtpAgent, RichText, AtUri } from '@atproto/api';


// Utility type for the reply structure required by Bsky API
interface ReplyRef{
    root: { uri: string, cid: string };
    parent: { uri: string, cid: string }
}

// Utility interface for Google Search sources
interface Source {
    uri: string;
    title: string;
}

export interface MentionEvent extends BaseEventMention {
    authorDid: string;

    // replying post
    uri: string;
    cid: string;

    // thread root
    rootUri: string;
    rootCid: string;
    postUri: string;
    postCid: string;
    // cleaned text
    cleanQuery: string;
}

// Char constant 
const MAX_POST_LENGTH = 300;


export class ElewaService{
    // console logger
    private readonly logger = {
    log: (message: string, ...optionalParams: any[]) => console.log(`[ElewaService] LOG: ${message}`, ...optionalParams),
    error: (message: string, ...optionalParams: any[]) => console.error(`[ElewaService] ERROR: ${message}`, ...optionalParams),
  };

  // Constants for reply text
  private static readonly PROCESSING_TEXT = "Processing your request... (This post will be deleted once the summary is ready.)";
  private static readonly ERROR_TEXT = "Oops! Ran into an issue generating the explanation. Please try again later!";
    private static readonly NO_QUERY_TEXT = "I need some text to explain! Please include a post or question for me to summarize or analyze after mentioning my handle.";

  // Properties now hold the actual instantiated objects from the plugins
  private readonly bsky: AtpAgent;
  private readonly gemini: GenerativeModel;

    constructor(bsky: AtpAgent, gemini: GenerativeModel){
        this.bsky = bsky;
        this.gemini = gemini;
    }

    private splitTextIntoPosts(text: string): string []{
        const chunks: string[] = [];
        let remainingText = text;

        while(remainingText.length > 0){
            const maxContentLength = MAX_POST_LENGTH - 6;

            let chunk = remainingText;
            let splitPoint = remainingText.length;

            if(remainingText.length > maxContentLength){
                // If too long trunck at it las last space
                chunk = remainingText.substring(0, maxContentLength);
                splitPoint = maxContentLength;

                
                // Try to find the last space before the limit to avoid splitting words
                const idealSplitPoint = chunk.lastIndexOf(' ');

                // Ensure the split point is a useful distance from the end (e.g., > 10 chars back)
                if (idealSplitPoint > 15) { 
                    chunk = remainingText.substring(0, idealSplitPoint);
                    splitPoint = idealSplitPoint;
                }
            }
            chunks.push(chunk.trim());
            remainingText = remainingText.substring(splitPoint).trim();
        }

        // Pagination
        const totalParts = chunks.length;
        return chunks.map((chunk, index) => {
            // Only add pagination if there's more than one post
            if (totalParts > 1) {
                 return `${chunk} (${index + 1}/${totalParts})`;
            }
            return chunk;
        });
    }

    // Helper function to execute post Bsky API
    private async postRecord(text:string, replyRef?:ReplyRef, retries = 5):Promise<{uri:string,cid:string}>{
        for (let attempt = 0; attempt < retries; attempt++) {
            try {
                const richText = new RichText({text});
                await richText.detectFacets(this.bsky);

                const postData:any = {
                    $type: 'app.bsky.feed.post',
                    text: richText.text,
                    facets: richText.facets,
                    reply: replyRef,
                    createdAt: new Date().toISOString(),
                };

                const response = await this.bsky.com.atproto.repo.createRecord({
                    repo: this.bsky.session!.did,
                    collection: 'app.bsky.feed.post',
                    record: postData,
                });
                
                // Success, return the result
                return {uri:response.data.uri,cid:response.data.cid};

            } catch (error) {
                // Check if this is the last attempt
                if (attempt === retries - 1) {
                    this.logger.error(`Posting to Bluesky failed after ${retries} attempts.`, error);
                    throw error; // Re-throw the error to be caught by handleMention's final catch
                }
                
                // Log and wait for exponential backoff
                const delay = Math.pow(2, attempt) * 500; // Start delay at 0.5s, 1s, 2s, 4s...
                this.logger.log(`Bluesky post failed (Attempt ${attempt + 1}), retrying in ${delay}ms...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
        // Should be unreachable but ensures function always returns or throws
        throw new Error('Post record loop unexpectedly terminated.');
     }

    // Format citations (sources)
    private formatSources(sources: Source[]): string{
        if(sources.length === 0){
            return '';
        }
        let formatted = '\n\nSources:\n';
        sources.forEach((source, index) => {
            formatted += `${index + 1}. ${source.title} ${source.uri}\n`;
        });
        return formatted;
    }

    private async safeGeminiCall(payload: any, retries = 5): Promise<any> {
        const { env: { GEMINI_API_KEY } } = await import('../../config/env.js');
        const GEMINI_MODEL_NAME = "gemini-2.5-flash-lite";

        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL_NAME}:generateContent?key=${GEMINI_API_KEY}`;
        
        for (let attempt = 0; attempt < retries; attempt++) {
            try {
                const response = await fetch(apiUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });

                if (response.ok) {
                    return response.json();
                }

                // If not OK, check for rate limiting errors (429)
                if (response.status === 429 && attempt < retries - 1) {
                    const delay = Math.pow(2, attempt) * 1000;
                    this.logger.log(`Rate limit hit, retrying in ${delay / 1000}s...`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                    continue; // Continue to the next attempt
                }
                
                // For other errors, throw
                throw new Error(`API call failed with status: ${response.status}`);

            } catch (error) {
                if (attempt === retries - 1) {
                    throw error;
                }
                const delay = Math.pow(2, attempt) * 1000;
                this.logger.log(`Attempt ${attempt + 1} failed, retrying in ${delay / 1000}s...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }

    private async deleteRecord(uri:string):Promise<void>{
        try{
            const atUri = new AtUri(uri);
            await this.bsky.com.atproto.repo.deleteRecord({
            repo: this.bsky.session!.did,
            collection: 'app.bsky.feed.post',
            rkey: atUri.rkey,
        });
        this.logger.log(`Successfully deleted record at ${uri}`);


        } catch(err){
            this.logger.error(`Failed to delete record at ${uri}`);
        }
        
    }

    public async handleMention(data:MentionEvent):Promise<void>{
        const { cleanQuery, authorDid, uri, cid, rootUri, rootCid } = data;

        // --- CHECK: If the query is empty, post guidance and exit ---
        if (!cleanQuery || cleanQuery.trim().length === 0) {
            this.logger.log("Query is empty. Posting guidance message.");
            const initialReplyRef: ReplyRef = {
                root: { uri: rootUri, cid: rootCid },
                parent: { uri, cid }
            };
            const guidanceText = `@${authorDid} ${ElewaService.NO_QUERY_TEXT}`;
            // Use postRecord which now has retry logic
            await this.postRecord(guidanceText, initialReplyRef);
            return;
        }

        // Reply references
        const originalPostRef = { uri, cid }
        const threadPostRef = { uri:rootUri, cid:rootCid }

        const initialReplyRef:ReplyRef = {
            root: threadPostRef,
            parent: originalPostRef
        };

        // Processing the initial Msg

        let processingPostRef: {uri:string, cid:string} | undefined;
        let currentParentRef: {uri:string, cid:string} = originalPostRef;
        let sources: Source[] = [];

        try{
            this.logger.log("Posting initial processing message");
            processingPostRef = await this.postRecord(ElewaService.PROCESSING_TEXT, initialReplyRef);
            this.logger.log(`'Processing' post successfully created: ${processingPostRef.uri}`);
             // The next reply should go to this processing post
            currentParentRef = processingPostRef;

        } catch(err){
            this.logger.error("Failed to post initial processing message");
            return;
        }

        // Generating the summary using Gemini
        let summaryText: string;
        try{

            // --- FIX: Add System Instruction for robust output and clarity ---
            const systemInstruction = "You are a helpful Bluesky bot called Elewa. Analyze the user's query and provide a concise, accurate explanation. When using search grounding, always synthesize information from the sources. Your response must be in plain text, suitable for a social media reply, and must not be empty.";
            
            // Construct the effective prompt for Gemini
            // We use the cleanQuery as the direct instruction to the model.
            const userPrompt = `Please generate an explanation based on this text and the context of the thread: "${cleanQuery}"`;

             // --- NEW: Payload includes Google Search Grounding Tool ---
            const payload = {
                contents: [{ role: "user", parts: [{ text: userPrompt }] }],
                tools: [{ "google_search": {} }], // Enable search grounding
                systemInstruction: { parts: [{ text: systemInstruction }] }
            };

            const geminiResponse = await this.safeGeminiCall(payload);
            const candidate = geminiResponse.candidates?.[0];
            const generatedText = candidate?.content?.parts?.[0]?.text;

            if (generatedText && generatedText.trim().length > 0) {
                summaryText = generatedText;
                this.logger.log("Gemini generation successful and returned valid text.");
            } else {
                summaryText = ElewaService.ERROR_TEXT;
                this.logger.error("Gemini generation successful but returned empty or invalid text. Falling back to error message.");
            }

            // --- NEW: Extract Grounding Sources ---
            const groundingMetadata = candidate?.groundingMetadata;
            if (groundingMetadata && groundingMetadata.groundingAttributions) {
                sources = groundingMetadata.groundingAttributions
                    .map((attribution: any) => ({
                        uri: attribution.web?.uri,
                        title: attribution.web?.title,
                    }))
                    .filter((source: Source) => source.uri && source.title);
            }

        } catch (err) {
            this.logger.error('Gemini API call failed entirely. Posting error reply.', err);
            summaryText = ElewaService.ERROR_TEXT;
        }
        
        try {
            this.logger.log(`Posting final summary reply.`);
            
            // 1. Prepend the handle and explanation intro
            let baseContent = `@${authorDid} Here is your explanation:\n\n${summaryText}`;
            
            // 2. Format sources and calculate if they fit in the last chunk
            const sourceText = this.formatSources(sources);
            
            // 3. If there are sources, try to append them to the main body of text BEFORE splitting
            // This is a simple heuristic: if the summary is very short, append sources before splitting.
            if (sources.length > 0 && baseContent.length < MAX_POST_LENGTH - sourceText.length) {
                 baseContent += sourceText;
                 this.logger.log('Appended sources directly to a single post.');
            }

            // 4. Split the text into postable chunks
            let postableChunks = this.splitTextIntoPosts(baseContent);
            this.logger.log(`Splitting response into ${postableChunks.length} chunks.`);

            // 5. If we have sources but they weren't appended, add them as the FINAL chunk
            // This ensures they are always the last post in the thread.
            if (sources.length > 0 && !baseContent.includes(sourceText)) {
                postableChunks.push(`\n---\n**Sources (Grounding Metadata):**\n` + sources.map((s, i) => `[${i + 1}] ${s.title} (${s.uri})`).join('\n'));
                this.logger.log('Added sources as a separate, final post.');
            }

            // 2. Post the thread
            for (const chunk of postableChunks) {
                // Ensure the root remains the original thread root
                const replyRef: ReplyRef = {
                    root: threadPostRef, 
                    parent: currentParentRef, 
                };

                const response = await this.postRecord(chunk, replyRef);
                
                // Update the parent for the next post in the thread
                currentParentRef = { uri: response.uri, cid: response.cid };
            };

            this.logger.log(`Final summary successfully posted. Proceeding to delete 'Processing' post.`);

            // --- 5. Clean up: Delete the 'Processing' post ---
            // if(processingPostRef){
            //     await this.deleteRecord(processingPostRef.uri);
            // }
            
            } catch (error) {
                this.logger.error(`Failed to post final reply or delete 'Processing' post.`, error);
            }
        }
    }

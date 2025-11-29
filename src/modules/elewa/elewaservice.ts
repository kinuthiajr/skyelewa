
import type { MentionEvent as BaseEventMention } from '../../core/entity/type.js';
import type { GenerativeModel } from '@google/generative-ai';
import { AtpAgent, RichText, AtUri } from '@atproto/api';


// Utility type for the reply structure required by Bsky API
interface ReplyRef{
    root: { uri: string, cid: string };
    parent: { uri: string, cid: string }
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
    private async postRecord(text:string, replyRef?:ReplyRef):Promise<{uri:string,cid:string}>{
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

        return {uri:response.data.uri,cid:response.data.cid};
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
            const geminiResponse = await this.gemini.generateContent({
                contents: [{ role: "user", parts: [{ text: cleanQuery }] }],
                //  tools: [{ googleSearch: {} }]
            });

            const candidate = geminiResponse?.response?.candidates?.[0]?.content?.parts?.[0];
            summaryText = candidate?.text ?? ElewaService.ERROR_TEXT;
            this.logger.log("Successfully generated summary from Gemini");
        } catch (err) {
            this.logger.error('Gemini generation failed. Posting error reply.', err);
            summaryText = ElewaService.ERROR_TEXT;
        }
        
        try {
            this.logger.log(`Posting final summary reply.`);
            
                 // 1. Split the summary text into postable chunks
            const baseContent = `@${authorDid} Here is your explanation:\n\n${summaryText}`;
            const postableChunks = this.splitTextIntoPosts(baseContent);
            this.logger.log(`Splitting response into ${postableChunks.length} chunks.`);

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
            if(processingPostRef){
                await this.deleteRecord(processingPostRef.uri);
            }
            
            } catch (error) {
                this.logger.error(`Failed to post final reply or delete 'Processing' post.`, error);
            }
        }
    }

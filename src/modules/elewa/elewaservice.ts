
import type { MentionEvent as BaseEventMention } from '../../core/entity/type.js';
import type { GenerativeModel } from '@google/generative-ai';
import { AtpAgent, RichText, AtUri } from '@atproto/api';


// Utility type for the reply structure required by Bsky API
interface ReplyRef{
    root: { uri: string, cid: string };
    parent: { uri: string, cid: string }
}

interface MentionEvent extends BaseEventMention{
     // The AT URI of the post the bot is directly replying to (the mention post)
    uri: string;
    // The CID of the post the bot is directly replying to (the mention post)
    cid: string;
    // The AT URI of the root post of the thread
    rootUri: string;
    // The CID of the root post of the thread
    rootCid: string;  
}

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

        let processingPostRef: {uri:string, cid:string}
        try{
            this.logger.log("Posting initial processing message");
            processingPostRef = await this.postRecord(ElewaService.PROCESSING_TEXT, initialReplyRef);
            this.logger.log(`'Processing' post successfully created: ${processingPostRef.uri}`);

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
            
            // The Final Summary replies to the 'Processing' post.
            const finalReplyRef: ReplyRef = {
                root: threadPostRef, 
                parent: processingPostRef, // New parent is the 'Processing' post
            };

            const finalContent = `@${authorDid} Here is your explanation:\n\n${summaryText}`;
            
            await this.postRecord(
                finalContent,
                finalReplyRef,
            );

            this.logger.log(`Final summary successfully posted. Proceeding to delete 'Processing' post.`);

            // --- 5. Clean up: Delete the 'Processing' post ---
            await this.deleteRecord(processingPostRef.uri);
            
            } catch (error) {
                this.logger.error(`Failed to post final reply or delete 'Processing' post.`, error);
            }
        }
    }

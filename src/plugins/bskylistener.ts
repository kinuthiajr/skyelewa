// Plugin: Connects to the Bluesky Jetstream maintains a persistent WebSocket connection
// listens for new posts, filters them for mentions, and hands clean data to the service.

import type { FastifyPluginAsync } from 'fastify'; 
import fp from 'fastify-plugin';
import { Jetstream } from '@skyware/jetstream';
import type { CommitEvent, CollectionOrWildcard } from '@skyware/jetstream'; 
import { ElewaService } from '../modules/elewa/elewaservice.js';
import type {MentionEvent } from '../modules/elewa/elewaservice.js';
import { AppBskyFeedPost } from '@atproto/api';

// Configs
const BOT_HANDLE = '@skyeleza.bsky.social';
const JETSTREAM_ENDPOINT = 'wss://jetstream1.us-west.bsky.network/subscribe';

export const blueskyListenerPlugin: FastifyPluginAsync = fp(async (fastify, opts) => {
    fastify.log.info('Starting Bluesky Listener Plugin setup...');
    
    // DI and service instanciation
    const elewaService = new ElewaService(fastify.bsky, fastify.gemini);
    fastify.log.info('ElewaService instantiated with necessary agents.');

    // JetStream client initialization
    const jetStream = new Jetstream<CollectionOrWildcard>({
        endpoint: JETSTREAM_ENDPOINT,
        wantedCollections: ['app.bsky.feed.post'],
    });

    fastify.log.info(`JetStream client initialized for ${BOT_HANDLE}.`);

    const getContextualizedQuery = async (record:AppBskyFeedPost.Record, mentionQuery:string):Promise<string>=>{
        if( !record.reply || !record.reply.parent?.uri ){
            return mentionQuery;
        }

        const parentUri = record.reply.parent.uri;

        try{
            fastify.log.info(`Fetching parent post context for URI: ${parentUri}`);

            // bsky agent to fetch the thread
            const threadResponse = await fastify.bsky.app.bsky.feed.getPostThread({
                uri: parentUri,
                depth: 0,
            });
            const parentPost = threadResponse.data.thread;

            // Check if the post was successfully retrieved and is a standard post
            if (parentPost && 'post' in parentPost && parentPost.post.record?.text) {

                const parentText = parentPost.post.record.text;
                
                // Combine the parent text with the mention query, clearly marking the source
                const contextualizedQuery = `Context from Parent Post: "${parentText}"\nUser Query/Action: "${mentionQuery}"`;
                fastify.log.info(`Contextualized Query created: ${contextualizedQuery}`);
                return contextualizedQuery;
            }
             } catch (err) {
                fastify.log.error(`${err}: Error retrieving parent post for context`);
                return mentionQuery;
            }

            return mentionQuery;
        
    }

    // Setup the event listener for new posts
    // Listen for new commit events
    jetStream.on('app.bsky.feed.post', async (event: CommitEvent<'app.bsky.feed.post'>) => {
        try{
            // Filter 1 - Only process 'create' operations (new posts)
            if (event.commit.operation !== 'create') {
                return;
            }
            const record = event.commit.record as any;
            const fulltext = record?.text  || '';
            
            // Filter 2 - Check if the post mentions the elewa
            if (!fulltext.includes(BOT_HANDLE)){
                return;
            }

            // data adaptation--Mapping to the MentionEvent
            
            // remove bothandle
            const mentionQuery = fulltext.replace(BOT_HANDLE,'').trim();

            // If the mention is in a thread, the root and parent are in the reply property.
            // If it's a new post, the root and parent are the post itself.
            const cleanQuery = await getContextualizedQuery(record, mentionQuery);
            
            // Determine the Post's own URI and CID (the replying post)
            const postUri = `at://${event.did}/app.bsky.feed.post/${event.commit.rkey}`;
            const postCid = event.commit.cid;

            // Determine the Thread Root URI and CID
            let rootUri = postUri;
            let rootCid = postCid;

             // If it's a reply, the root is defined in the record
            if (record.reply && record.reply.root) {
                rootUri = record.reply.root.uri;
                rootCid = record.reply.root.cid;
            }

            const mentionPost: MentionEvent = {
                authorDid: event.did,
                // Replying post properties
                uri: postUri, 
                cid: postCid,
                // Thread root properties
                rootUri: rootUri,
                rootCid: rootCid,
                postUri: postUri, // <-- ADDED to fix the compile error
                postCid: postCid,
                // The query
                cleanQuery: cleanQuery,
            };

            // Hand off the clean, typed data to the Service Logic
            // The Listener's job is done here; the Service takes over.
            await elewaService.handleMention(mentionPost);

        } catch(err){
            fastify.log.error(err, 'Error processing mention event in Jetstream listener');
        }

    },);

    // Start the JetStream connection
    await jetStream.start();
    fastify.log.info('JetStream connection started and listening for mentions.');


    fastify.addHook('onClose', async () => {
        jetStream.close();
        fastify.log.info('Jetstream connection closed.');
    });
        
    fastify.log.info('Bluesky Listener Plugin setup complete.');
});
export default fp(blueskyListenerPlugin, {
    name: 'bluesky-listener',
    // Ensure all required agents are loaded before this plugin runs
    dependencies: ['gemini-agent', 'bluesky-agent'] 
});
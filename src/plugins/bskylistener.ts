// Plugin: Connects to the Bluesky Jetstream maintains a persistent WebSocket connection
// listens for new posts, filters them for mentions, and hands clean data to the service.

import type { FastifyPluginAsync } from 'fastify'; 
import fp from 'fastify-plugin';
import { Jetstream } from '@skyware/jetstream';
import type { CommitEvent, CollectionOrWildcard } from '@skyware/jetstream'; 
import { ElewaService } from '../modules/elewa/elewaservice.js';
import type {MentionEvent } from '../modules/elewa/elewaservice.js';

// Configs
const BOT_HANDLE = '@skyelewa.bsky.social';
const JETSTREAM_ENDPOINT = 'wss://jetstream1.us-west.bsky.network/subscribe';

export const blueskyListenerPlugin: FastifyPluginAsync = fp(async (fastify, opts) => {
    fastify.log.info('Starting Bluesky Listener Plugin setup...');
    
    // DI and service instanciation
    const elewaService = new ElewaService(fastify.bsky, fastify.gemini);
    fastify.log.info('ExplainService instantiated with necessary agents.');

    // JetStream client initialization
    const jetStream = new Jetstream<CollectionOrWildcard>({
        endpoint: JETSTREAM_ENDPOINT,
        wantedCollections: ['app.bsky.feed.post'],
    });

    fastify.log.info(`JetStream client initialized for ${BOT_HANDLE}.`);

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
            const cleanQuery = fulltext.replace(BOT_HANDLE,'').trim();

            // If the mention is in a thread, the root and parent are in the reply property.
            // If it's a new post, the root and parent are the post itself.
             const postUri = `at://${event.did}/app.bsky.feed.post/${event.commit.rkey}`;

            // The root may or may not exist
            const root = record?.reply?.root ?? {
                uri: postUri,
                cid: event.commit.cid
            };

            const mentionPost: MentionEvent = {
                uri: postUri,
                cid: event.commit.cid,
                rootUri: root.uri,
                rootCid: root.cid,
                authorDid: event.did,
                cleanQuery: cleanQuery,
                postCid: event.commit.cid,
                postUri: postUri
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
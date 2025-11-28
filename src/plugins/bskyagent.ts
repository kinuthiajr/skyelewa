
// Plugin: This plugin initializes the Bluesky AtpAgent and decorates the Fastify instance with it.
// Allows other parts of the application to access the Bluesky API via fastify.bsky.

import fp from 'fastify-plugin';
import {AtpAgent} from '@atproto/api';

declare module 'fastify'{
    interface FastifyInstance{
        bsky:AtpAgent;
    }
}

export default fp(async (fastify) => {
    try{
        const { env: { BLUESKY_IDENTIFIER, BLUESKY_PASSWORD } } = await import('../config/env.js');

        const agent = new AtpAgent({service:'https://bsky.social'});
        
        if (!BLUESKY_IDENTIFIER || !BLUESKY_PASSWORD) {
            throw new Error('Missing BLUESKY_IDENTIFIER or BLUESKY_PASSWORD environment variables.');
        }

        await agent.login({identifier:BLUESKY_IDENTIFIER,password:BLUESKY_PASSWORD});
        fastify.decorate('bsky',agent);
        fastify.log.info('Bluesky agent initialized and logged in.');
    } catch (err){
        fastify.log.error(err,'Failed to initialize Bluesky agent');
        throw err;
    }
}, {
    name: 'bluesky-agent'
    
});
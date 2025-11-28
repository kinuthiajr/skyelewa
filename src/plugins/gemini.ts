
// Plugin: This plugin initializes the Gemini API client and decorates the Fastify instance with it.
// Allows other parts of the application to access the Gemini API via fastify.gemini.

import fp from 'fastify-plugin';
import { GoogleGenerativeAI, GenerativeModel } from '@google/generative-ai';
import { env } from '../config/env.js';

declare module 'fastify'{
    interface FastifyInstance{
        gemini: GenerativeModel;
    }
}

export default fp(async (fastify) => {
    try {
        if (!env.GEMINI_API_KEY) {
            throw new Error('Missing GEMINI_API_KEY environment variable.');
        }

        const gemini = new GoogleGenerativeAI(env.GEMINI_API_KEY);
        const model = gemini.getGenerativeModel({ 
            model: "gemini-2.5-flash-lite",
            systemInstruction: "You are SkyExplain, a concise bot that summarizes user posts on the Bluesky social network within 280 characters."
        });
        fastify.decorate('gemini', model);
        fastify.log.info('🔵 Gemini API initialized.');
    } catch (err) {
        fastify.log.error(err, '🔴 Failed to initialize Gemini API');
        throw err;
    }
});
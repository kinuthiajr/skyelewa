// This is the entry of the application and also registreation of plugins

import Fastify from 'fastify';
import geminiPlugin from './plugins/gemini.js'; 
import bskyagentPlugin from './plugins/bskyagent.js';
import { env } from './config/env.js';
import { blueskyListenerPlugin } from './plugins/bskylistener.js';

const app = Fastify({ logger: true });

const start = async () => {
  try {
    // Register your plugins
    await app.register(geminiPlugin);        // now gemini-agent is registered
    await app.register(bskyagentPlugin); 

     // --- 2. Register Listener (Consumes Dependencies) ---
      // This is the critical step to start the Jetstream connection.
    await app.register(blueskyListenerPlugin);

    app.get('/status', async (request, reply) => {
      const status = {
        gemini: app.gemini ? 'Ready' : 'Not Loaded',
        bsky: app.bsky?.session ? 'Logged In' : 'Not Loaded or Login Failed'
      };

      // If any plugin failed, return a server error status code
      const isOk = Object.values(status).every(s => s.startsWith('✅'));

      reply.code(isOk ? 200 : 500).send(status);
    });
    
    // Start the server
    const port = Number(env.PORT) || 3000; // Default to 3000 if PORT is not set
    await app.listen({ port });
    app.log.info(`🚀 Server running at http://localhost:${port}`);

  } catch (err) {
    app.log.error(err, 'Application startup failed');
    process.exit(1);
  }
};

start();
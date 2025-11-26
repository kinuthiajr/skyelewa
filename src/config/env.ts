import dotenv from 'dotenv';
dotenv.config(); // MUST run before exporting env

export const env = {
    PORT: process.env.PORT || '3000',
    GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
    BLUESKY_PASSWORD: process.env.BLUESKY_PASSWORD || '',
    BLUESKY_IDENTIFIER: process.env.BLUESKY_IDENTIFIER || ''
};

console.log("ENV LOADED FROM env.ts:", env); // temporary debug

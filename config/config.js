const dotenv = require('dotenv');
const path = require('path');
require('dotenv').config();

// Define environment
const environment = process.env.NODE_ENV || 'development';

// Load the environment variable based on the environment
const loadEnvironmentVariables = () => {
        const envFiles = {
            development: '.env.development',
            production: '.env.production',
            local: '.env.local'
    };
  
    const envFile = envFiles[environment] || '.env';
    
    dotenv.config({
      path: path.resolve(process.cwd(), envFile)
    });

    const privateKey = process.env.PRIVATE_KEY
        ? process.env.PRIVATE_KEY.replace(/\\n/g, '\n')
        : undefined;

    // Enhanced CORS configuration with more flexible origins
const defaultOrigins = [
        'https://goldfish-app-gu3zc.ondigitalocean.app',
        'https://lobster-app-4scgy.ondigitalocean.app',
        'https://zingoclient-cndio.ondigitalocean.app',
        'http://localhost:3000',
        'http://localhost:3001',
        'http://localhost:9000',
        'http://127.0.0.1:3000',
        'http://127.0.0.1:9000',
        'http://192.168.18.6:3000',
        'https://king-prawn-app-rrla3.ondigitalocean.app',
        'https://acmereserve.com',
        'https://www.acmereserve.com',
        'https://afterglow-monsieur-quarterly.ngrok-free.dev',
        'https://afterglow-monsieur-quarterly.ngrok-free.app',
        'https://afterglow-monsieur-quarterly.ngrok-free.dev/tg'
    ];

    const corsOrigins = process.env.CORS_ORIGINS
        ? [...new Set([...process.env.CORS_ORIGINS.split(','), ...defaultOrigins])]
        : defaultOrigins;
  
    return {
        NODE_ENV: environment,
        PORT: parseInt(process.env.PORT, 10) || 9000,
        CORS_ORIGINS: corsOrigins,
        firebase: {
            type: process.env.FIREBASE_TYPE,
            project_id: process.env.PROJECT_ID,
            private_key_id: process.env.PRIVATE_KEY_ID,
            private_key: privateKey,
            client_email: process.env.CLIENT_EMAIL,
            client_id: process.env.CLIENT_ID,
            auth_uri: process.env.AUTH_URI,
            token_uri: process.env.TOKEN_URI,
            auth_provider_x509_cert_url: process.env.AUTH_PROVIDER_X509_CERT_URL,
            client_x509_cert_url: process.env.CLIENT_X509_CERT_URL,
            universe_domain: process.env.UNIVERSE_DOMAIN
        },
        postgres: {
            user: process.env.POSTGRESQL_USERNAME,
            host: process.env.POSTGRESQL_HOST,
            database: process.env.POSTGRESQL_DATABASE,
            password: process.env.POSTGRESQL_PASSWORD,
            port: parseInt(process.env.POSTGRESQL_PORT, 10) || 5432,
            ssl: environment === 'production' ? {
                rejectUnauthorized: false
            } : false
        },
        taggerService: {
            url: process.env.TAGGER_SERVICE_URL || 'http://localhost:6001',
            apiKey: process.env.TAGGER_API_KEY,
            timeout: 30000,
            retries:3 
        }
    };
};
  
const config = loadEnvironmentVariables();

module.exports = config;
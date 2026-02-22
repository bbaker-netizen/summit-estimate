// fetch-logo.js - Netlify function: server-side image proxy
// Fetches an image URL and returns it as base64 (bypasses CORS for iframe)
const https = require('https');
const http = require('http');

exports.handler = async function(event) {
    const url = (event.queryStringParameters && event.queryStringParameters.url) || '';
    if (!url || !/^https?:\/\//i.test(url)) {
          return { statusCode: 400, body: JSON.stringify({ error: 'Missing or invalid url param' }) };
    }
    try {
          const b64 = await fetchAsBase64(url);
          return {
                  statusCode: 200,
                  headers: {
                            'Content-Type': 'application/json',
                            'Access-Control-Allow-Origin': '*'
                  },
                  body: JSON.stringify({ b64 })
          };
    } catch(e) {
          return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
    }
};

function fetchAsBase64(url) {
    return new Promise((resolve, reject) => {
          const lib = url.startsWith('https') ? https : http;
          lib.get(url, (res) => {
                  if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                            return fetchAsBase64(res.headers.location).then(resolve).catch(reject);
                  }
                  const chunks = [];
                  res.on('data', c => chunks.push(c));
                  res.on('end', () => {
                            const buf = Buffer.concat(chunks);
                            const mime = res.headers['content-type'] || 'image/png';
                            resolve('data:' + mime + ';base64,' + buf.toString('base64'));
                  });
                  res.on('error', reject);
          }).on('error', reject);
    });
}

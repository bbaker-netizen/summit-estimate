// netlify/functions/save-estimate.js
// PDF upload relay for Monday.com
// Receives: { subitemId, pdfBase64, fileName }
// Uploads PDF to Monday Files column on the specified sub-item
// Sub-item creation is handled client-side via monday.api()

const fetch = require('node-fetch');
const FormData = require('form-data');

exports.handler = async function(event, context) {
    const headers = {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Content-Type': 'application/json'
    };

    if (event.httpMethod === 'OPTIONS') {
          return { statusCode: 200, headers, body: '' };
    }

    if (event.httpMethod !== 'POST') {
          return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

    let body;
    try {
          body = JSON.parse(event.body);
    } catch(e) {
          return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON body' }) };
    }

    const { subitemId, pdfBase64, fileName } = body;

    if (!subitemId || !pdfBase64 || !fileName) {
          return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing required fields: subitemId, pdfBase64, fileName' }) };
    }

    const MONDAY_API_TOKEN = process.env.MONDAY_API_TOKEN;
    if (!MONDAY_API_TOKEN) {
          return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server not configured: missing MONDAY_API_TOKEN' }) };
    }

    try {
          // Convert base64 PDF to buffer
      const pdfBuffer = Buffer.from(pdfBase64, 'base64');

      // Upload file to Monday.com Files column on the sub-item
      const query = `mutation add_file($file: File!) {
            add_file_to_column(item_id: ${subitemId}, column_id: "files", file: $file) {
                    id
                          }
                              }`;

      const form = new FormData();
          form.append('query', query);
          form.append('variables[file]', pdfBuffer, {
                  filename: fileName,
                  contentType: 'application/pdf'
          });

      const uploadResp = await fetch('https://api.monday.com/v2/file', {
              method: 'POST',
              headers: {
                        'Authorization': MONDAY_API_TOKEN,
                        ...form.getHeaders()
              },
              body: form
      });

      const uploadResult = await uploadResp.json();

      if (uploadResult.errors) {
              console.error('Monday upload error:', JSON.stringify(uploadResult.errors));
              return { statusCode: 200, headers, body: JSON.stringify({ ok: false, message: 'PDF upload failed: ' + JSON.stringify(uploadResult.errors) }) };
      }

      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, message: 'PDF uploaded successfully' }) };

    } catch(err) {
          console.error('save-estimate error:', err.message);
          return { statusCode: 500, headers, body: JSON.stringify({ ok: false, message: err.message }) };
    }
};

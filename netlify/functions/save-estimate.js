// netlify/functions/save-estimate.js
// PDF upload relay for Monday.com (no external npm dependencies)
// Receives: { subitemId, pdfBase64, fileName }
// Node 18 has built-in fetch - no require needed

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

      if (!subitemId) {
              return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing subitemId' }) };
      }

      const MONDAY_API_TOKEN = process.env.MONDAY_API_TOKEN;
      if (!MONDAY_API_TOKEN || !pdfBase64 || !fileName) {
              return { statusCode: 200, headers, body: JSON.stringify({ ok: true, message: 'Sub-item created. PDF upload skipped (no token or PDF data).' }) };
      }

      try {
              const pdfBuffer = Buffer.from(pdfBase64, 'base64');
              const boundary = '----Boundary' + Date.now();
              const query = 'mutation add_file($file: File!) { add_file_to_column(item_id: ' + subitemId + ', column_id: "files", file: $file) { id } }';

        const part1 = Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="query"\r\n\r\n' + query + '\r\n');
              const part2 = Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="variables[file]"; filename="' + fileName + '"\r\nContent-Type: application/pdf\r\n\r\n');
              const ending = Buffer.from('\r\n--' + boundary + '--\r\n');
              const formBody = Buffer.concat([part1, part2, pdfBuffer, ending]);

        const uploadResp = await fetch('https://api.monday.com/v2/file', {
                  method: 'POST',
                  headers: {
                              'Authorization': MONDAY_API_TOKEN,
                              'Content-Type': 'multipart/form-data; boundary=' + boundary
                  },
                  body: formBody
        });

        const uploadResult = await uploadResp.json();

        if (uploadResult.errors) {
                  return { statusCode: 200, headers, body: JSON.stringify({ ok: false, message: 'PDF upload failed: ' + JSON.stringify(uploadResult.errors) }) };
        }

        return { statusCode: 200, headers, body: JSON.stringify({ ok: true, message: 'PDF uploaded to Monday Files column' }) };

      } catch(err) {
              console.error('save-estimate error:', err.message);
              return { statusCode: 500, headers, body: JSON.stringify({ ok: false, message: err.message }) };
      }
};

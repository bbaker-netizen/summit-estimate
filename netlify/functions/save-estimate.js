// save-estimate.js  –  Netlify function
// Uses Node 18 native fetch + FormData for Monday file upload

const https = require('https');

// Low-level HTTPS POST helper (used for JSON API calls only)
function httpsPost(hostname, path, headers, body) {
    return new Promise((resolve, reject) => {
          const buf = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body), 'utf8');
          const opts = {
                  hostname, path, method: 'POST',
                  headers: { ...headers, 'Content-Length': buf.length }
          };
          const req = https.request(opts, res => {
                  let data = '';
                  res.on('data', c => { data += c; });
                  res.on('end', () => resolve({ status: res.statusCode, body: data }));
          });
          req.on('error', reject);
          req.write(buf);
          req.end();
    });
}

exports.handler = async (event) => {
    const cors = {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Content-Type': 'application/json'
    };

    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
    if (event.httpMethod !== 'POST') return { statusCode: 405, headers: cors, body: JSON.stringify({ error: 'Method not allowed' }) };

    let body;
    try { body = JSON.parse(event.body); } catch (e) {
          return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Invalid JSON' }) };
    }

    const { subitemId, parentItemId, pdfBase64, fileName, boardId, fileColId } = body;
    if (!subitemId) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Missing subitemId' }) };
    if (!pdfBase64) return { statusCode: 200, headers: cors, body: JSON.stringify({ success: true, message: 'No PDF' }) };

    const apiToken = process.env.MONDAY_API_TOKEN;
    if (!apiToken) return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'No API token configured' }) };

    const subitemIdInt = parseInt(subitemId, 10);
    const parentItemIdInt = parentItemId ? parseInt(parentItemId, 10) : null;
    console.log('subitemId:', subitemIdInt, 'parentId:', parentItemIdInt, 'fileColId:', fileColId);

    try {
          const pdfBuffer = Buffer.from(pdfBase64, 'base64');
          const safeFileName = (fileName || ('estimate_' + subitemIdInt + '.pdf')).replace(/[^a-zA-Z0-9._-]/g, '_');
          console.log('PDF size:', pdfBuffer.length, 'fileName:', safeFileName);

      const mondayHeaders = {
              'Authorization': apiToken,
              'API-Version': '2024-01'
      };

      // ── Step 1: Find the file column ──────────────────────────────────────────
      let uploadItemId = subitemIdInt;
          let uploadColId = fileColId || null;

      if (!uploadColId) {
              // Try parent item first
            if (parentItemIdInt) {
                      const r = await httpsPost('api.monday.com', '/v2',
                                                { ...mondayHeaders, 'Content-Type': 'application/json' },
                                                { query: `{ items(ids:[${parentItemIdInt}]){ board{ columns{ id title type } } } }` }
                                                        );
                      console.log('Parent cols status:', r.status);
                      try {
                                  const d = JSON.parse(r.body);
                                  const cols = d?.data?.items?.[0]?.board?.columns || [];
                                  const fc = cols.find(c => c.type === 'file');
                                  if (fc) {
                                                uploadItemId = parentItemIdInt;
                                                uploadColId = fc.id;
                                                console.log('Using parent item', uploadItemId, 'col', uploadColId);
                                  }
                      } catch (e) { console.log('Parent col parse err:', e.message); }
            }

            // Fallback: try sub-item columns
            if (!uploadColId) {
                      const r = await httpsPost('api.monday.com', '/v2',
                                                { ...mondayHeaders, 'Content-Type': 'application/json' },
                                                { query: `{ items(ids:[${subitemIdInt}]){ board{ columns{ id title type } } } }` }
                                                        );
                      console.log('Sub cols status:', r.status);
                      try {
                                  const d = JSON.parse(r.body);
                                  const cols = d?.data?.items?.[0]?.board?.columns || [];
                                  const fc = cols.find(c => c.type === 'file');
                                  if (fc) {
                                                uploadColId = fc.id;
                                                console.log('Using sub col', uploadColId);
                                  }
                      } catch (e) { console.log('Sub col parse err:', e.message); }
            }
      }

      if (!uploadColId) {
              return { statusCode: 404, headers: cors, body: JSON.stringify({ error: 'No file column found' }) };
      }

      console.log('Uploading to item:', uploadItemId, 'col:', uploadColId);

      // ── Step 2: Upload via multipart using native fetch + FormData ────────────
      // Node 18 has native fetch, FormData, Blob
      const mutation = `mutation ($file: File!) {
            add_file_to_column(item_id: ${uploadItemId}, column_id: "${uploadColId}", file: $file) { id }
                }`;

      const operations = JSON.stringify({
              query: mutation,
              variables: { file: null }
      });

      const map = JSON.stringify({ '0': ['variables.file'] });

      const form = new FormData();
          form.append('operations', operations);
          form.append('map', map);
          form.append('0', new Blob([pdfBuffer], { type: 'application/pdf' }), safeFileName);

      console.log('Sending multipart upload to Monday /v2/file...');
          const uploadRes = await fetch('https://api.monday.com/v2/file', {
                  method: 'POST',
                  headers: {
                            'Authorization': apiToken,
                            'API-Version': '2024-01'
                            // Do NOT set Content-Type here — let fetch set it with boundary
                  },
                  body: form
          });

      const uploadText = await uploadRes.text();
          console.log('Upload status:', uploadRes.status, 'body:', uploadText);

      let uploadData;
          try { uploadData = JSON.parse(uploadText); } catch (e) { uploadData = { raw: uploadText }; }

      if (uploadData?.data?.add_file_to_column?.id) {
              return {
                        statusCode: 200, headers: cors,
                        body: JSON.stringify({ success: true, method: 'add_file_to_column', fileId: uploadData.data.add_file_to_column.id })
              };
      }

      // If add_file_to_column failed, try add_file_to_update on the sub-item
      console.log('add_file_to_column failed, trying add_file_to_update...');
          const mutation2 = `mutation ($file: File!) {
                add_file_to_update(update_id: ${subitemIdInt}, file: $file) { id }
                    }`;
          const operations2 = JSON.stringify({ query: mutation2, variables: { file: null } });
          const form2 = new FormData();
          form2.append('operations', operations2);
          form2.append('map', JSON.stringify({ '0': ['variables.file'] }));
          form2.append('0', new Blob([pdfBuffer], { type: 'application/pdf' }), safeFileName);

      const uploadRes2 = await fetch('https://api.monday.com/v2/file', {
              method: 'POST',
              headers: { 'Authorization': apiToken, 'API-Version': '2024-01' },
              body: form2
      });
          const uploadText2 = await uploadRes2.text();
          console.log('Update upload status:', uploadRes2.status, 'body:', uploadText2);
          let uploadData2;
          try { uploadData2 = JSON.parse(uploadText2); } catch (e) { uploadData2 = { raw: uploadText2 }; }

      if (uploadData2?.data?.add_file_to_update?.id) {
              return {
                        statusCode: 200, headers: cors,
                        body: JSON.stringify({ success: true, method: 'add_file_to_update', fileId: uploadData2.data.add_file_to_update.id })
              };
      }

      return {
              statusCode: 200, headers: cors,
              body: JSON.stringify({ success: false, col_result: uploadData, update_result: uploadData2 })
      };

    } catch (err) {
          console.error('Error:', err.message, err.stack);
          return { statusCode: 500, headers: cors, body: JSON.stringify({ error: err.message }) };
    }
};

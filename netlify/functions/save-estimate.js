// save-estimate.js – Netlify function
// Monday file upload: uses Monday's proprietary multipart format
// map: {"image":"variables.file"}, file part named "image"

const https = require('https');

// Low-level HTTPS POST helper
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
        if (event.httpMethod !== 'POST') return { statusCode: 405, headers: cors, body: 'Method not allowed' };

        const token = process.env.MONDAY_API_TOKEN;
        if (!token) return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'Missing token' }) };

        let body;
        try { body = JSON.parse(event.body); }
        catch (e) { return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

        const { subitemId, parentItemId, boardId, fileColId, fileName, pdfBase64 } = body;

        console.log('subitemId:', subitemId, 'parentId:', parentItemId, 'fileColId:', fileColId);
        console.log('PDF size:', pdfBase64 ? Buffer.from(pdfBase64, 'base64').length : 0, 'fileName:', fileName);

        const authHeaders = {
                    'Authorization': token,
                    'API-Version': '2025-01'
        };

        // ── Step 1: Set date column on sub-item ──────────────────────────────────
        const today = new Date().toISOString().split('T')[0];
        const dateQuery = {
                    query: `mutation { change_column_value(board_id: ${parseInt(boardId, 10)}, item_id: ${parseInt(subitemId, 10)}, column_id: "date4", value: "{\\"date\\":\\"${today}\\"}") { id } }`
        };
        try {
                    const dr = await httpsPost('api.monday.com', '/v2', { ...authHeaders, 'Content-Type': 'application/json' }, dateQuery);
                    console.log('Date set status:', dr.status);
        } catch (e) {
                    console.log('Date set error:', e.message);
        }

        // ── Step 2: Upload PDF to sub-item file column ───────────────────────────
        // Monday's proprietary multipart format (NOT standard GraphQL multipart spec):
        //   field "query"  = mutation string
        //   field "map"    = {"image":"variables.file"}   ← key is "image", value is plain string
        //   field "image"  = the file binary              ← part name matches map key
        const itemIdInt = parseInt(subitemId, 10);
        const mutation = `mutation ($file: File!) { add_file_to_column(item_id: ${itemIdInt}, column_id: "${fileColId}", file: $file) { id } }`;

        const boundary = '----MondayUpload' + Date.now();
        const CRLF = '\r\n';
        const pdfBuffer = Buffer.from(pdfBase64, 'base64');
        const safeFileName = (fileName || 'estimate.pdf').replace(/[^\w.\-]/g, '_');

        // Build multipart body using Monday's format
        const parts = [];

        // Part 1: query
        parts.push(
                    `--${boundary}${CRLF}` +
                    `Content-Disposition: form-data; name="query"${CRLF}${CRLF}` +
                    mutation
                );

        // Part 2: map  (Monday uses {"image":"variables.file"} NOT {"0":["variables.file"]})
        parts.push(
                    `--${boundary}${CRLF}` +
                    `Content-Disposition: form-data; name="map"${CRLF}${CRLF}` +
                    '{"image":"variables.file"}'
                );

        // Part 3: file binary (named "image" to match map key)
        const fileHeader =
                    `--${boundary}${CRLF}` +
                    `Content-Disposition: form-data; name="image"; filename="${safeFileName}"${CRLF}` +
                    `Content-Type: application/pdf${CRLF}${CRLF}`;

        const closing = `${CRLF}--${boundary}--${CRLF}`;

        const uploadBody = Buffer.concat([
                    Buffer.from(parts[0] + CRLF, 'utf8'),
                    Buffer.from(parts[1] + CRLF, 'utf8'),
                    Buffer.from(fileHeader, 'utf8'),
                    pdfBuffer,
                    Buffer.from(closing, 'utf8')
                ]);

        console.log('Uploading to item:', itemIdInt, 'col:', fileColId);
        console.log('Multipart body size:', uploadBody.length, 'boundary:', boundary);
        console.log('Mutation:', mutation);

        const uploadHeaders = {
                    'Authorization': token,
                    'API-Version': '2025-01',
                    'Content-Type': `multipart/form-data; boundary=${boundary}`
        };

        try {
                    const ur = await httpsPost('api.monday.com', '/v2/file', uploadHeaders, uploadBody);
                    console.log('Upload status:', ur.status, 'body:', ur.body.substring(0, 200));

            let colResult;
                    try { colResult = JSON.parse(ur.body); } catch (e) { colResult = { raw: ur.body }; }

            if (ur.status === 200 && colResult.data && colResult.data.add_file_to_column) {
                            return {
                                                statusCode: 200,
                                                headers: cors,
                                                body: JSON.stringify({ success: true, col_result: colResult })
                            };
            }

            // ── Fallback: try add_file_to_update ─────────────────────────────────
            console.log('add_file_to_column failed, trying add_file_to_update...');
                    const updateMutation = `mutation ($file: File!) { add_file_to_update(update_id: ${itemIdInt}, file: $file) { id } }`;

            const parts2 = [];
                    parts2.push(
                                    `--${boundary}${CRLF}` +
                                    `Content-Disposition: form-data; name="query"${CRLF}${CRLF}` +
                                    updateMutation
                                );
                    parts2.push(
                                    `--${boundary}${CRLF}` +
                                    `Content-Disposition: form-data; name="map"${CRLF}${CRLF}` +
                                    '{"image":"variables.file"}'
                                );

            const uploadBody2 = Buffer.concat([
                            Buffer.from(parts2[0] + CRLF, 'utf8'),
                            Buffer.from(parts2[1] + CRLF, 'utf8'),
                            Buffer.from(fileHeader, 'utf8'),
                            pdfBuffer,
                            Buffer.from(closing, 'utf8')
                        ]);

            const ur2 = await httpsPost('api.monday.com', '/v2/file', uploadHeaders, uploadBody2);
                    console.log('Update upload status:', ur2.status, 'body:', ur2.body.substring(0, 200));

            let updateResult;
                    try { updateResult = JSON.parse(ur2.body); } catch (e) { updateResult = { raw: ur2.body }; }

            return {
                            statusCode: 200,
                            headers: cors,
                            body: JSON.stringify({ success: ur2.status === 200, col_result: colResult, update_result: updateResult })
            };

        } catch (e) {
                    console.log('Upload error:', e.message);
                    return {
                                    statusCode: 200,
                                    headers: cors,
                                    body: JSON.stringify({ success: false, error: e.message })
                    };
        }
};

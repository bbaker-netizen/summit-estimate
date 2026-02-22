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

function mondayQuery(token, query) {
            return httpsPost('api.monday.com', '/v2',
                             { 'Authorization': token, 'API-Version': '2025-01', 'Content-Type': 'application/json' },
                             { query }
                                 ).then(r => {
                            const parsed = JSON.parse(r.body);
                            if (parsed.errors) throw new Error(JSON.stringify(parsed.errors));
                            return parsed;
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
            const itemIdInt = parseInt(subitemId, 10);
            const boardIdInt = parseInt(boardId, 10);

            console.log('subitemId:', subitemId, 'parentId:', parentItemId, 'boardId:', boardId, 'fileColId:', fileColId);
            console.log('PDF size:', pdfBase64 ? Buffer.from(pdfBase64, 'base64').length : 0, 'fileName:', fileName);

            // ── Step 1: Query sub-item board columns to find date + file column IDs ──
            let dateColId = null;
            let resolvedFileColId = fileColId;
            try {
                            const colRes = await mondayQuery(token,
                                                                         `{ boards(ids: [${boardIdInt}]) { columns { id title type } } }`
                                                                     );
                            const cols = (colRes.data.boards[0] || {}).columns || [];
                            console.log('Board columns:', JSON.stringify(cols.map(c => ({ id: c.id, title: c.title, type: c.type }))));
                            for (const col of cols) {
                                                if (col.type === 'date' || col.title.toLowerCase().includes('date')) {
                                                                        dateColId = col.id;
                                                }
                                                if (!resolvedFileColId && (col.type === 'file' || col.title.toLowerCase().includes('doc') || col.title.toLowerCase().includes('estimate'))) {
                                                                        resolvedFileColId = col.id;
                                                }
                            }
                            console.log('Resolved dateColId:', dateColId, 'fileColId:', resolvedFileColId);
            } catch (e) {
                            console.log('Column query error:', e.message);
            }

            // ── Step 2: Set date column on sub-item ──────────────────────────────────
            const today = new Date().toISOString().split('T')[0];
            if (dateColId) {
                            try {
                                                const dr = await mondayQuery(token,
                                                                                             `mutation { change_column_value(board_id: ${boardIdInt}, item_id: ${itemIdInt}, column_id: "${dateColId}", value: "{\\"date\\":\\"${today}\\"}") { id } }`
                                                                                         );
                                                console.log('Date set OK:', JSON.stringify(dr.data));
                            } catch (e) {
                                                console.log('Date set error:', e.message);
                            }
            } else {
                            console.log('No date column found on board', boardIdInt);
            }

            // ── Step 3: Upload PDF to sub-item file column ───────────────────────────
            if (!pdfBase64) {
                            return { statusCode: 200, headers: cors, body: JSON.stringify({ success: true, note: 'No PDF to upload' }) };
            }
            if (!resolvedFileColId) {
                            return { statusCode: 200, headers: cors, body: JSON.stringify({ success: false, error: 'No file column found' }) };
            }

            // Monday's proprietary multipart format:
            //   "query"  = mutation string
            //   "map"    = {"image":"variables.file"}   ← NOT the GraphQL multipart spec
            //   "image"  = the file binary
            const mutation = `mutation ($file: File!) { add_file_to_column(item_id: ${itemIdInt}, column_id: "${resolvedFileColId}", file: $file) { id } }`;
            const boundary = '----MondayUpload' + Date.now();
            const CRLF = '\r\n';
            const pdfBuffer = Buffer.from(pdfBase64, 'base64');
            const safeFileName = (fileName || 'estimate.pdf').replace(/[^\w.\-]/g, '_');

            const part1 = `--${boundary}${CRLF}Content-Disposition: form-data; name="query"${CRLF}${CRLF}${mutation}`;
            const part2 = `--${boundary}${CRLF}Content-Disposition: form-data; name="map"${CRLF}${CRLF}{"image":"variables.file"}`;
            const fileHeader = `--${boundary}${CRLF}Content-Disposition: form-data; name="image"; filename="${safeFileName}"${CRLF}Content-Type: application/pdf${CRLF}${CRLF}`;
            const closing = `${CRLF}--${boundary}--${CRLF}`;

            const uploadBody = Buffer.concat([
                            Buffer.from(part1 + CRLF, 'utf8'),
                            Buffer.from(part2 + CRLF, 'utf8'),
                            Buffer.from(fileHeader, 'utf8'),
                            pdfBuffer,
                            Buffer.from(closing, 'utf8')
                        ]);

            console.log('Uploading', pdfBuffer.length, 'bytes to item:', itemIdInt, 'col:', resolvedFileColId);
            console.log('Total multipart size:', uploadBody.length);

            const uploadHeaders = {
                            'Authorization': token,
                            'API-Version': '2025-01',
                            'Content-Type': `multipart/form-data; boundary=${boundary}`
            };

            try {
                            const ur = await httpsPost('api.monday.com', '/v2/file', uploadHeaders, uploadBody);
                            console.log('Upload status:', ur.status, 'body:', ur.body.substring(0, 300));

                let colResult;
                            try { colResult = JSON.parse(ur.body); } catch (e) { colResult = { raw: ur.body }; }

                const success = ur.status === 200 && colResult.data && colResult.data.add_file_to_column;
                            return {
                                                statusCode: 200,
                                                headers: cors,
                                                body: JSON.stringify({ success, col_result: colResult, dateColId, resolvedFileColId })
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

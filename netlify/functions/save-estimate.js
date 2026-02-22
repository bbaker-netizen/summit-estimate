const https = require('https');

function httpsPost(hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const opts = { hostname, path, method: 'POST', headers: { ...headers, 'Content-Length': body.length } };
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  let body;
  try { body = JSON.parse(event.body); } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { subitemId, parentItemId, pdfBase64, fileName, boardId, fileColId } = body;
  if (!subitemId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing subitemId' }) };
  if (!pdfBase64) return { statusCode: 200, headers, body: JSON.stringify({ success: true, message: 'No PDF' }) };

  const apiToken = process.env.MONDAY_API_TOKEN;
  if (!apiToken) return { statusCode: 500, headers, body: JSON.stringify({ error: 'No token' }) };

  const subitemIdInt = parseInt(subitemId, 10);
  const parentItemIdInt = parentItemId ? parseInt(parentItemId, 10) : null;
  console.log('subitemId:', subitemIdInt, 'parentId:', parentItemIdInt);

  try {
    const pdfBuffer = Buffer.from(pdfBase64, 'base64');
    const safeFileName = (fileName || ('estimate_' + subitemIdInt + '.pdf')).replace(/[^a-zA-Z0-9._-]/g, '_');
    console.log('PDF size:', pdfBuffer.length);

    const CRLF = Buffer.from([0x0d, 0x0a]);
    const boundary = 'MondayBound' + Date.now();

    function makePart(name, value) {
      return Buffer.concat([
        Buffer.from('--' + boundary), CRLF,
        Buffer.from('Content-Disposition: form-data; name="' + name + '"'), CRLF,
        CRLF,
        Buffer.from(typeof value === 'string' ? value : JSON.stringify(value), 'utf8'), CRLF
      ]);
    }
    function makeFilePart(name, fname, buf) {
      return Buffer.concat([
        Buffer.from('--' + boundary), CRLF,
        Buffer.from('Content-Disposition: form-data; name="' + name + '"; filename="' + fname + '"'), CRLF,
        Buffer.from('Content-Type: application/pdf'), CRLF,
        CRLF,
        buf, CRLF
      ]);
    }

    // Strategy 1: Try add_file_to_column on parent item with parentItemId
    // First query parent item columns
    let uploadItemId = subitemIdInt;
    let uploadColId = fileColId || null;

    if (parentItemIdInt && !uploadColId) {
      const qBuf = Buffer.from(JSON.stringify({
        query: '{ items(ids:[' + parentItemIdInt + ']){ board{ columns{ id title type } } } }'
      }), 'utf8');
      const qRes = await httpsPost('api.monday.com', '/v2', {
        'Content-Type': 'application/json', 'Authorization': apiToken
      }, qBuf);
      console.log('Parent cols query status:', qRes.status);
      try {
        const qData = JSON.parse(qRes.body);
        const cols = qData?.data?.items?.[0]?.board?.columns || [];
        console.log('Parent cols:', JSON.stringify(cols.map(c=>({id:c.id,title:c.title,type:c.type}))));
        const fc = cols.find(c => c.type === 'file');
        if (fc) {
          uploadItemId = parentItemIdInt;
          uploadColId = fc.id;
          console.log('Using parent item', uploadItemId, 'col', uploadColId);
        }
      } catch(e) { console.log('Col query parse err:', e.message); }
    }

    if (!uploadColId) {
      console.log('No file col found, trying subitem cols');
      const qBuf = Buffer.from(JSON.stringify({
        query: '{ items(ids:[' + subitemIdInt + ']){ board{ columns{ id title type } } } }'
      }), 'utf8');
      const qRes = await httpsPost('api.monday.com', '/v2', {
        'Content-Type': 'application/json', 'Authorization': apiToken
      }, qBuf);
      try {
        const qData = JSON.parse(qRes.body);
        const cols = qData?.data?.items?.[0]?.board?.columns || [];
        console.log('Sub cols:', JSON.stringify(cols.map(c=>({id:c.id,title:c.title,type:c.type}))));
        const fc = cols.find(c => c.type === 'file');
        if (fc) { uploadColId = fc.id; console.log('Using sub col', uploadColId); }
      } catch(e) {}
    }

    if (!uploadColId) return { statusCode: 404, headers, body: JSON.stringify({ error: 'No file col' }) };

    // Try add_file_to_column
    const mutation1 = 'mutation add_file($file: File!) { add_file_to_column(item_id: ' + uploadItemId + ', column_id: "' + uploadColId + '", file: $file) { id } }';
    console.log('Mutation:', mutation1);

    const ops1 = JSON.stringify({ query: mutation1, variables: { file: null } });
    const map1 = JSON.stringify({ '0': ['variables.file'] });
    const uploadBody = Buffer.concat([
      makePart('operations', ops1),
      makePart('map', map1),
      makeFilePart('0', safeFileName, pdfBuffer),
      Buffer.from('--' + boundary + '--'), CRLF
    ]);

    const r1 = await httpsPost('api.monday.com', '/v2/file', {
      'Authorization': apiToken,
      'Content-Type': 'multipart/form-data; boundary=' + boundary
    }, uploadBody);
    console.log('add_file_to_column status:', r1.status, 'body:', r1.body);

    let d1;
    try { d1 = JSON.parse(r1.body); } catch(e) { d1 = { raw: r1.body }; }

    if (d1?.data?.add_file_to_column?.id) {
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, method: 'column', fileId: d1.data.add_file_to_column.id }) };
    }

    // Strategy 2: Try add_file_to_update
    console.log('Trying add_file_to_update on item:', uploadItemId);
    const mutation2 = 'mutation add_file($file: File!) { add_file_to_update(update_id: ' + uploadItemId + ', file: $file) { id } }';
    const ops2 = JSON.stringify({ query: mutation2, variables: { file: null } });
    const boundary2 = 'MondayBound2_' + Date.now();
    const uploadBody2 = Buffer.concat([
      Buffer.concat([
        Buffer.from('--' + boundary2), CRLF,
        Buffer.from('Content-Disposition: form-data; name="operations"'), CRLF, CRLF,
        Buffer.from(ops2, 'utf8'), CRLF
      ]),
      Buffer.concat([
        Buffer.from('--' + boundary2), CRLF,
        Buffer.from('Content-Disposition: form-data; name="map"'), CRLF, CRLF,
        Buffer.from(JSON.stringify({'0':['variables.file']}), 'utf8'), CRLF
      ]),
      Buffer.concat([
        Buffer.from('--' + boundary2), CRLF,
        Buffer.from('Content-Disposition: form-data; name="0"; filename="' + safeFileName + '"'), CRLF,
        Buffer.from('Content-Type: application/pdf'), CRLF, CRLF,
        pdfBuffer, CRLF
      ]),
      Buffer.from('--' + boundary2 + '--'), CRLF
    ]);

    const r2 = await httpsPost('api.monday.com', '/v2/file', {
      'Authorization': apiToken,
      'Content-Type': 'multipart/form-data; boundary=' + boundary2
    }, uploadBody2);
    console.log('add_file_to_update status:', r2.status, 'body:', r2.body);

    let d2;
    try { d2 = JSON.parse(r2.body); } catch(e) { d2 = { raw: r2.body }; }

    if (d2?.data?.add_file_to_update?.id) {
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, method: 'update', fileId: d2.data.add_file_to_update.id }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify({ success: false, col_result: d1, update_result: d2 }) };

  } catch (err) {
    console.error('Error:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};

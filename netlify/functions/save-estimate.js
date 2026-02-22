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

  const { subitemId, pdfBase64, fileName, boardId, fileColId } = body;
  if (!subitemId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing subitemId' }) };
  if (!pdfBase64) return { statusCode: 200, headers, body: JSON.stringify({ success: true, message: 'No PDF to upload' }) };

  const apiToken = process.env.MONDAY_API_TOKEN;
  if (!apiToken) return { statusCode: 500, headers, body: JSON.stringify({ error: 'MONDAY_API_TOKEN not set' }) };

  const subitemIdInt = parseInt(subitemId, 10);
  console.log('subitemId int:', subitemIdInt);
  console.log('Token prefix:', apiToken.substring(0, 20));

  try {
    const pdfBuffer = Buffer.from(pdfBase64, 'base64');
    console.log('PDF buffer size:', pdfBuffer.length);
    const safeFileName = (fileName || ('estimate_' + subitemIdInt + '.pdf')).replace(/[^a-zA-Z0-9._-]/g, '_');

    // Step 1: Find file column
    let targetFileColId = fileColId;
    if (!targetFileColId) {
      const subQuery = JSON.stringify({
        query: '{ items(ids:[' + subitemIdInt + ']){ board{ id columns{ id title type } } } }'
      });
      const subRes = await fetch('https://api.monday.com/v2', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': apiToken, 'API-Version': '2024-01' },
        body: subQuery
      });
      const subData = await subRes.json();
      const cols = subData?.data?.items?.[0]?.board?.columns || [];
      console.log('Columns:', JSON.stringify(cols.map(c => ({ id: c.id, title: c.title, type: c.type }))));
      const fCol = cols.find(c =>
        c.type === 'file' ||
        (c.title || '').toLowerCase().includes('estimate') ||
        (c.title || '').toLowerCase().includes('doc')
      );
      targetFileColId = fCol?.id;
      console.log('File col:', targetFileColId, fCol?.title);
    }

    if (!targetFileColId) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'No file column found' }) };
    }

    // Step 2: Upload via FormData (Node 18 native)
    const mutation = 'mutation add_file($file: File!) { add_file_to_column(item_id: ' + subitemIdInt + ', column_id: "' + targetFileColId + '", file: $file) { id } }';
    console.log('Mutation:', mutation);

    const operations = JSON.stringify({ query: mutation, variables: { file: null } });
    const map = JSON.stringify({ '0': ['variables.file'] });

    const form = new FormData();
    form.append('operations', operations);
    form.append('map', map);
    form.append('0', new Blob([pdfBuffer], { type: 'application/pdf' }), safeFileName);

    console.log('Sending FormData upload...');
    const uploadRes = await fetch('https://api.monday.com/v2/file', {
      method: 'POST',
      headers: {
        'Authorization': apiToken,
        'API-Version': '2024-01'
        // Note: Do NOT set Content-Type manually - FormData sets it with boundary automatically
      },
      body: form
    });

    const uploadText = await uploadRes.text();
    console.log('Upload status:', uploadRes.status);
    console.log('Upload response:', uploadText.substring(0, 600));

    let uploadData;
    try { uploadData = JSON.parse(uploadText); } catch(e) { uploadData = { raw: uploadText.substring(0, 300) }; }

    if (uploadData?.data?.add_file_to_column?.id) {
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, fileId: uploadData.data.add_file_to_column.id }) };
    } else {
      return { statusCode: 200, headers, body: JSON.stringify({ success: false, uploadStatus: uploadRes.status, detail: uploadData }) };
    }

  } catch (err) {
    console.error('Error:', err.message, err.stack);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};

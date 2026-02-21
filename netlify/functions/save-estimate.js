// netlify/functions/save-estimate.js
// Handles PDF file upload to Monday.com sub-item + sets date column
// Called after sub-item is created by the app via monday.api()
// Node 18 has built-in fetch and FormData - no npm deps needed

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

  const { subitemId, pdfBase64, fileName, token } = body;

  if (!subitemId || !pdfBase64 || !token) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing required fields: subitemId, pdfBase64, token' }) };
  }

  // Step 1: Get the sub-item's board to find column IDs
  let fileColId = null;
  let dateColId = null;
  try {
    const colQuery = `{ items(ids: [${subitemId}]) { board { columns { id title type } } } }`;
    const colRes = await fetch('https://api.monday.com/v2', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': token,
        'API-Version': '2024-01'
      },
      body: JSON.stringify({ query: colQuery })
    });
    const colData = await colRes.json();
    const columns = colData.data && colData.data.items && colData.data.items[0] && colData.data.items[0].board && colData.data.items[0].board.columns;
    if (columns) {
      for (const col of columns) {
        if (col.type === 'file' && !fileColId) fileColId = col.id;
        if (col.type === 'date' && !dateColId) dateColId = col.id;
        // Prefer columns with "Estimate" or "Doc" in title for file col
        if (col.type === 'file' && (col.title.toLowerCase().includes('estimate') || col.title.toLowerCase().includes('doc'))) {
          fileColId = col.id;
        }
        // Prefer columns with "Date" in title for date col
        if (col.type === 'date' && col.title.toLowerCase().includes('date')) {
          dateColId = col.id;
        }
      }
    }
    console.log('Columns found:', JSON.stringify(columns ? columns.map(c => ({id:c.id,title:c.title,type:c.type})) : []));
    console.log('Using fileColId:', fileColId, 'dateColId:', dateColId);
  } catch(e) {
    console.error('Column query error:', e.message);
  }

  const results = { subitemId, fileColId, dateColId, fileUploaded: false, dateSet: false };

  // Step 2: Upload PDF to file column
  if (fileColId && pdfBase64) {
    try {
      // Convert base64 to buffer
      const pdfBuffer = Buffer.from(pdfBase64, 'base64');
      const safeName = (fileName || 'estimate.pdf').replace(/[^a-zA-Z0-9._-]/g, '_');

      // Monday file upload uses multipart GraphQL
      const uploadQuery = `mutation add_file($file: File!) {
        add_file_to_column(item_id: ${subitemId}, column_id: "${fileColId}", file: $file) {
          id
        }
      }`;

      const formData = new FormData();
      formData.append('query', uploadQuery);
      const blob = new Blob([pdfBuffer], { type: 'application/pdf' });
      formData.append('variables[file]', blob, safeName);

      const uploadRes = await fetch('https://api.monday.com/v2/file', {
        method: 'POST',
        headers: {
          'Authorization': token,
          'API-Version': '2024-01'
        },
        body: formData
      });
      const uploadData = await uploadRes.json();
      console.log('File upload result:', JSON.stringify(uploadData));
      if (uploadData.data && uploadData.data.add_file_to_column) {
        results.fileUploaded = true;
        results.fileAssetId = uploadData.data.add_file_to_column.id;
      } else if (uploadData.errors) {
        results.fileError = JSON.stringify(uploadData.errors);
      }
    } catch(e) {
      console.error('File upload error:', e.message);
      results.fileError = e.message;
    }
  }

  // Step 3: Set date column to today
  if (dateColId) {
    try {
      const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
      const dateVal = JSON.stringify({ date: today });
      const dateMutation = `mutation {
        change_column_value(item_id: ${subitemId}, column_id: "${dateColId}", value: ${JSON.stringify(dateVal)}) {
          id
        }
      }`;
      const dateRes = await fetch('https://api.monday.com/v2', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': token,
          'API-Version': '2024-01'
        },
        body: JSON.stringify({ query: dateMutation })
      });
      const dateData = await dateRes.json();
      console.log('Date set result:', JSON.stringify(dateData));
      if (dateData.data && dateData.data.change_column_value) {
        results.dateSet = true;
      } else if (dateData.errors) {
        results.dateError = JSON.stringify(dateData.errors);
      }
    } catch(e) {
      console.error('Date set error:', e.message);
      results.dateError = e.message;
    }
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ ok: true, ...results })
  };
};

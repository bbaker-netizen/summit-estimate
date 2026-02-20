// netlify/functions/save-estimate.js
// Backend relay for Monday.com file upload + sub-item creation
// Receives: { token, itemId, boardId, subitemName, pdfBase64, fileName }
// Returns: { ok, subitemId, message }

exports.handler = async function(event, context) {
  // CORS headers for the iframe origin
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

  const { token, itemId, subitemName, pdfBase64, fileName } = body;
  if (!token || !itemId || !subitemName) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing required fields: token, itemId, subitemName' }) };
  }

  const MONDAY_API = 'https://api.monday.com/v2';
  const authHeader = { 'Authorization': token, 'Content-Type': 'application/json', 'API-Version': '2024-01' };

  try {
    // Step 1: Create the sub-item
    const createMutation = {
      query: `mutation($name: String!, $parentId: ID!) {
        create_subitem(parent_item_id: $parentId, item_name: $name, create_labels_if_missing: true) {
          id
          name
        }
      }`,
      variables: { name: subitemName, parentId: String(itemId) }
    };

    const createRes = await fetch(MONDAY_API, {
      method: 'POST',
      headers: authHeader,
      body: JSON.stringify(createMutation)
    });
    const createData = await createRes.json();

    if (createData.errors) {
      console.error('Create subitem error:', JSON.stringify(createData.errors));
      return {
        statusCode: 200, headers,
        body: JSON.stringify({ ok: false, message: 'Sub-item creation failed: ' + createData.errors[0].message })
      };
    }

    const subitemId = createData.data && createData.data.create_subitem && createData.data.create_subitem.id;
    if (!subitemId) {
      return { statusCode: 200, headers, body: JSON.stringify({ ok: false, message: 'No subitem ID returned' }) };
    }

    // Step 2: Upload PDF to the sub-item Files column (if PDF provided)
    if (pdfBase64 && fileName) {
      try {
        const pdfBuffer = Buffer.from(pdfBase64, 'base64');

        // Monday file upload uses multipart/form-data with GraphQL
        const uploadQuery = 'mutation($file: File!) { add_file_to_column(item_id: ' + subitemId + ', column_id: "files", file: $file) { id } }';

        const boundary = '----FormBoundary' + Math.random().toString(36).slice(2);
        const CRLF = '\r\n';

        // Build multipart body manually
        let multipartParts = [];
        multipartParts.push(
          '--' + boundary + CRLF +
          'Content-Disposition: form-data; name="query"' + CRLF + CRLF +
          uploadQuery + CRLF
        );
        multipartParts.push(
          '--' + boundary + CRLF +
          'Content-Disposition: form-data; name="variables[file]"; filename="' + fileName + '"' + CRLF +
          'Content-Type: application/pdf' + CRLF + CRLF
        );

        const header = Buffer.from(multipartParts[0] + multipartParts[1], 'utf8');
        const footer = Buffer.from(CRLF + '--' + boundary + '--' + CRLF, 'utf8');
        const fullBody = Buffer.concat([header, pdfBuffer, footer]);

        const uploadRes = await fetch('https://api.monday.com/v2/file', {
          method: 'POST',
          headers: {
            'Authorization': token,
            'API-Version': '2024-01',
            'Content-Type': 'multipart/form-data; boundary=' + boundary
          },
          body: fullBody
        });

        const uploadText = await uploadRes.text();
        console.log('Upload response:', uploadText);
      } catch(uploadErr) {
        console.warn('File upload warning (subitem was created):', uploadErr.message);
        // Don't fail the whole operation - subitem exists, just no file
      }
    }

    return {
      statusCode: 200, headers,
      body: JSON.stringify({ ok: true, subitemId, subitemName, message: 'Saved: ' + subitemName })
    };

  } catch(err) {
    console.error('save-estimate error:', err);
    return {
      statusCode: 500, headers,
      body: JSON.stringify({ ok: false, message: err.message })
    };
  }
};

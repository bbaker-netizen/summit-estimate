// netlify/functions/qbo-connect.js
// Accepts manually pasted tokens (from Intuit OAuth Playground)
// and validates them by fetching the company name from QBO.

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  const { accessToken, refreshToken, realmId } = body;
  if (!accessToken || !refreshToken || !realmId) {
    return { statusCode: 400, body: 'Missing accessToken, refreshToken, or realmId' };
  }

  // Validate the tokens by fetching company info
  let companyName = 'QuickBooks Company';
  try {
    const infoRes = await fetch(
      `https://sandbox-quickbooks.api.intuit.com/v3/company/${realmId}/companyinfo/${realmId}?minorversion=65`,
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Accept': 'application/json'
        }
      }
    );

    if (!infoRes.ok) {
      const errData = await infoRes.text();
      return {
        statusCode: infoRes.status,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          error: 'token_validation_failed',
          message: 'Could not validate tokens against QBO. The access token may be expired \u2014 try refreshing first.',
          detail: errData
        })
      };
    }

    const infoData = await infoRes.json();
    companyName = infoData?.QueryResponse?.CompanyInfo?.[0]?.CompanyName
               || infoData?.CompanyInfo?.CompanyName
               || companyName;
  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'server_error', message: err.message })
    };
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      access_token:  accessToken,
      refresh_token: refreshToken,
      realmId,
      companyName,
      validated: true
    })
  };
};

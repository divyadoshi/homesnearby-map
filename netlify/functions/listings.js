// Netlify serverless function — DDF listings proxy
// Credentials stay server-side, never exposed to browser

const DDF_CLIENT_ID     = 'KkLvmT3LOetNsY8ZWuOS745e';
const DDF_CLIENT_SECRET = 'jOvFEKxe0u8jn5DKvhxSJr6z';
const TOKEN_URL         = 'https://identity.crea.ca/connect/token';
const DDF_API           = 'https://ddfapi.realtor.ca/odata/v1/Property';
const PAGE_SIZE         = 100; // DDF hard limit per request

async function getToken() {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=client_credentials&client_id=${DDF_CLIENT_ID}&client_secret=${DDF_CLIENT_SECRET}`
  });
  const data = await res.json();
  return data.access_token;
}

async function fetchPage(token, filter, select, skip) {
  const url = `${DDF_API}?$filter=${encodeURIComponent(filter)}&$select=${encodeURIComponent(select)}&$top=${PAGE_SIZE}&$skip=${skip}`;
  const res  = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  return data.value || [];
}

async function fetchAllListings(token, filter, select) {
  const firstPage = await fetchPage(token, filter, select, 0);
  if (firstPage.length < PAGE_SIZE) return firstPage;

  const skips = [];
  for (let s = PAGE_SIZE; s < 2000; s += PAGE_SIZE) skips.push(s);

  const pages = await Promise.all(
    skips.map(s => fetchPage(token, filter, select, s).catch(() => []))
  );

  let all = [...firstPage];
  for (const page of pages) {
    if (!page.length) break;
    all = all.concat(page);
    if (page.length < PAGE_SIZE) break;
  }
  return all;
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
    'Cache-Control': 'public, max-age=900, s-maxage=900, stale-while-revalidate=60'
  };

  try {
    const city     = event.queryStringParameters?.city     || 'Abbotsford';
    const province = event.queryStringParameters?.province || 'British Columbia';

    const token  = await getToken();
    const filter = `StateOrProvince eq '${province}' and City eq '${city}' and StandardStatus eq 'Active'`;
    const select = [
      'ListingKey','ListPrice','BedroomsTotal','BathroomsTotalInteger',
      'Latitude','Longitude','StreetNumber','StreetName','StreetSuffix',
      'PropertySubType','ListingURL','Media','PostalCode',
      'LivingArea','LivingAreaUnits','LotSizeArea','LotSizeUnits',
      'YearBuilt','TaxAnnualAmount','TaxYear',
      'AssociationFee','AssociationFeeFrequency',
      'ParkingTotal','ParkingFeatures','FireplacesTotal',
      'Heating','Cooling','Basement',
      'PublicRemarks','ListingId'
    ].join(',');

    const allListings = await fetchAllListings(token, filter, select);

    const listings = allListings
      .filter(l => l.Latitude && l.Longitude)
      .map(l => ({
        id:        l.ListingKey,
        price:     l.ListPrice,
        beds:      l.BedroomsTotal,
        baths:     l.BathroomsTotalInteger,
        lat:       l.Latitude,
        lng:       l.Longitude,
        address:   `${l.StreetNumber || ''} ${l.StreetName || ''} ${l.StreetSuffix || ''}`.trim(),
        type:      l.PropertySubType,
        url:       l.ListingURL ? `https://www.realtor.ca/real-estate/${l.ListingKey}/${l.ListingURL.split('/').pop()}` : `https://www.realtor.ca/real-estate/${l.ListingKey}`,
        photos:    (l.Media || []).filter(m => m.MediaCategory === 'Property Photo').slice(0, 5).map(m => m.MediaURL).filter(Boolean),
        postal:    l.PostalCode || '',
        sqft:      l.LivingArea || null,
        sqftUnit:  l.LivingAreaUnits || 'square feet',
        lotSize:   l.LotSizeArea || null,
        lotUnit:   l.LotSizeUnits || null,
        yearBuilt: l.YearBuilt || null,
        tax:       l.TaxAnnualAmount ? { amount: l.TaxAnnualAmount, year: l.TaxYear } : null,
        strata:    l.AssociationFee  ? { fee: l.AssociationFee, freq: l.AssociationFeeFrequency } : null,
        parking:   (l.ParkingFeatures || []).join(', ') || (l.ParkingTotal ? l.ParkingTotal + ' spaces' : null) || null,
        fireplaces: l.FireplacesTotal || null,
        heating:   (l.Heating || []).join(', ') || null,
        cooling:   (l.Cooling || []).join(', ') || null,
        basement:  (l.Basement || []).filter(b => b !== 'Unknown').join(', ') || null,
        remarks:   l.PublicRemarks ? l.PublicRemarks.substring(0, 250) : null,
        mlsNum:    l.ListingId || null
      }));

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ count: listings.length, listings })
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message })
    };
  }
};
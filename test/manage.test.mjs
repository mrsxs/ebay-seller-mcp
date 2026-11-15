import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseItemDetail, parseSellingList, sellingRequest } from '../lib/manage.mjs';

test('sellingRequest asks for one list and switches the sold list (buyer data) off', () => {
  const body = sellingRequest({ status: 'active', page: 2, pageSize: 10, sort: 'StartTimeDescending' });
  assert.match(body, /<ActiveList><Include>true<\/Include><Sort>StartTimeDescending<\/Sort><Pagination><EntriesPerPage>10<\/EntriesPerPage><PageNumber>2<\/PageNumber><\/Pagination><\/ActiveList>/);
  assert.match(body, /<SoldList><Include>false<\/Include><\/SoldList>/);
  assert.match(body, /<UnsoldList><Include>false<\/Include><\/UnsoldList>/);
  assert.match(sellingRequest({ status: 'unsold' }), /<UnsoldList><Include>true<\/Include>/);
  assert.throws(() => sellingRequest({ status: 'sold' }), /未知列表/);
});

const VAR = (sku, size, price, qty, sold) => `<Variation><SKU>${sku}</SKU><StartPrice currencyID="USD">${price}</StartPrice><Quantity>${qty}</Quantity>
  <VariationSpecifics><NameValueList><Name>Size</Name><Value>${size}</Value></NameValueList></VariationSpecifics><SellingStatus><QuantitySold>${sold}</QuantitySold></SellingStatus></Variation>`;

test('parseSellingList: single and multi-variation rows', () => {
  const xml = `<ActiveList><ItemArray>
    <Item><ItemID>111111111111</ItemID><Title>Tree &amp; Grass</Title><SKU>T-1</SKU><Quantity>12</Quantity><QuantityAvailable>9</QuantityAvailable>
      <SellingStatus><CurrentPrice currencyID="USD">5.99</CurrentPrice><QuantitySold>3</QuantitySold></SellingStatus><WatchCount>4</WatchCount><TimeLeft>P3D</TimeLeft></Item>
    <Item><ItemID>222222222222</ItemID><Title>Lamp</Title><SellingStatus><CurrentPrice currencyID="USD">16.99</CurrentPrice></SellingStatus>
      <Variations>${VAR('L-S', 'S', '16.99', 10, 2)}${VAR('L-L', 'L', '21.99', 5, 5)}</Variations></Item>
  </ItemArray><PaginationResult><TotalNumberOfPages>3</TotalNumberOfPages><TotalNumberOfEntries>122</TotalNumberOfEntries></PaginationResult></ActiveList>`;
  const r = parseSellingList(xml, 'active');
  assert.deepEqual([r.total, r.pages, r.items.length], [122, 3, 2]);
  assert.deepEqual(r.items[0], { item_id: '111111111111', title: 'Tree & Grass', sku: 'T-1', price: 5.99, currency: 'USD', price_max: null, quantity_available: 9, quantity_sold: 3, watchers: 4,
    variations: 0, time_left: 'P3D', end_time: null, url: 'https://www.ebay.com/itm/111111111111' });
  assert.deepEqual([r.items[1].price, r.items[1].price_max, r.items[1].quantity_available, r.items[1].quantity_sold, r.items[1].variations], [16.99, 21.99, 8, 7, 2]);
});

test('parseItemDetail: variations, pictures, policies; seller block ignored; quantity = total − sold', () => {
  const xml = `<GetItemResponse><Item><ItemID>227612275584</ItemID><Title>Diorama Base</Title><Country>CN</Country><Location>Shenzhen</Location>
    <PrimaryCategory><CategoryID>262323</CategoryID><CategoryName>Toys &amp; Hobbies:Dioramas</CategoryName></PrimaryCategory><ConditionID>1000</ConditionID><ConditionDisplayName>New</ConditionDisplayName>
    <Seller><UserID>someone</UserID><Site>HongKong</Site></Seller>
    <SellingStatus><QuantitySold>7</QuantitySold><ListingStatus>Active</ListingStatus></SellingStatus>
    <Description>&lt;p&gt;Hello&lt;/p&gt;</Description>
    <PictureDetails><PictureURL>https://i.ebayimg.com/a.jpg</PictureURL><PictureURL>https://i.ebayimg.com/b.jpg</PictureURL></PictureDetails>
    <ItemSpecifics><NameValueList><Name>Brand</Name><Value>Unbranded</Value></NameValueList><NameValueList><Name>Color</Name><Value>Green</Value><Value>Brown</Value></NameValueList></ItemSpecifics>
    <Variations>${VAR('B-S', 'S', '9.99', 10, 2)}${VAR('B-L', 'L', '12.99', 5, 5)}
      <Pictures><VariationSpecificName>Size</VariationSpecificName><VariationSpecificPictureSet><VariationSpecificValue>S</VariationSpecificValue><PictureURL>https://i.ebayimg.com/s.jpg</PictureURL></VariationSpecificPictureSet></Pictures>
      <VariationSpecificsSet><NameValueList><Name>Size</Name><Value>S</Value><Value>L</Value></NameValueList></VariationSpecificsSet></Variations>
    <SellerProfiles><SellerShippingProfile><ShippingProfileID>1</ShippingProfileID><ShippingProfileName>Ship</ShippingProfileName></SellerShippingProfile>
      <SellerReturnProfile><ReturnProfileID>2</ReturnProfileID><ReturnProfileName>Ret</ReturnProfileName></SellerReturnProfile>
      <SellerPaymentProfile><PaymentProfileID>3</PaymentProfileID><PaymentProfileName>Pay</PaymentProfileName></SellerPaymentProfile></SellerProfiles>
    <ListingDetails><StartTime>2026-11-13T09:02:59.000Z</StartTime><EndTime>2026-12-13T09:02:59.000Z</EndTime></ListingDetails></Item></GetItemResponse>`;
  const d = parseItemDetail(xml);
  assert.equal(d.title, 'Diorama Base');
  assert.equal(d.status, 'Active');
  assert.deepEqual(d.category, { id: '262323', name: 'Toys & Hobbies:Dioramas' });
  assert.equal(d.description, '<p>Hello</p>');
  assert.deepEqual(d.images, ['https://i.ebayimg.com/a.jpg', 'https://i.ebayimg.com/b.jpg']);
  assert.deepEqual(d.aspects, { Brand: 'Unbranded', Color: ['Green', 'Brown'] });
  assert.equal(d.price, null);
  assert.equal(d.quantity_sold, 7);
  assert.deepEqual(d.variations.specifics, [{ name: 'Size', values: ['S', 'L'] }]);
  assert.equal(d.variations.picture_by, 'Size');
  assert.deepEqual(d.variations.pictures, { S: ['https://i.ebayimg.com/s.jpg'] });
  assert.deepEqual(d.variations.items[1], { sku: 'B-L', values: { Size: 'L' }, price: 12.99, quantity_available: 0, quantity_sold: 5 });
  assert.deepEqual(d.policies.return, { id: '2', name: 'Ret' });
  assert.equal(d.location.location, 'Shenzhen');
  assert.ok(!JSON.stringify(d).includes('someone'), 'seller user id is not returned');
});

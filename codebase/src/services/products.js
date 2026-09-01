function money(value) {
  return Number.parseFloat(value).toFixed(2);
}

function toDisplayProduct(row) {
  const price = money(row.price);
  const salePrice = row.sale_price == null ? null : money(row.sale_price);
  const displayPrice = salePrice ?? price;
  return {
    id: row.id,
    sku: row.sku,
    name: row.name,
    description: row.description,
    category: {
      id: row.category_id,
      slug: row.category_slug,
      name: row.category_name
    },
    price,
    salePrice,
    displayPrice,
    onSale: Boolean(salePrice),
    stock: row.stock,
    inStock: row.stock > 0,
    rating: row.rating == null ? null : Number.parseFloat(row.rating),
    ratingCount: row.rating_count ?? 0,
    imageUrl: row.image_url,
    isActive: row.is_active
  };
}

const PRODUCT_SELECT = `
  SELECT
    p.id, p.sku, p.name, p.description, p.price, p.sale_price, p.stock,
    p.rating, p.rating_count, p.image_url, p.is_active, p.category_id,
    c.slug AS category_slug, c.name AS category_name
  FROM products p
  JOIN categories c ON c.id = p.category_id
`;

module.exports = { money, toDisplayProduct, PRODUCT_SELECT };

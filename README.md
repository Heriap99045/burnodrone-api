# burnodrone-api

API admin untuk katalog BurnoDrone (Hono + Supabase). Front end ada di repo `burnodrone`.

## Endpoint
| Method | Path | Keterangan |
| --- | --- | --- |
| GET | `/health` | cek hidup |
| POST | `/admin/products` | tambah produk |
| PUT | `/admin/products/:id` | ubah produk |
| DELETE | `/admin/products/:id` | hapus produk |
| POST | `/admin/upload` | unggah gambar (multipart, field `file`) ke bucket `product-images` |

Semua `/admin/*` memerlukan header `Authorization: Bearer <access_token Supabase>`
dari akun yang emailnya ada di `ADMIN_EMAILS`.

## Jalankan lokal
```bash
npm install
cp .env.example .env   # lalu isi nilainya
npm run dev
```

## Deploy
Cocok untuk Render, Railway, Fly.io, atau VPS: `npm install && npm run build`, lalu `npm start`.
Isi semua variabel dari `.env.example` di dashboard hosting.
# burnodrone-api

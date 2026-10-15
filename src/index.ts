import { randomUUID } from "node:crypto";
import { serve } from "@hono/node-server";
import { createClient } from "@supabase/supabase-js";
import { Hono } from "hono";
import { cors } from "hono/cors";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Environment variable ${name} belum diisi.`);
  return value;
}

const list = (value: string | undefined) =>
  (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const supabase = createClient(
  requireEnv("SUPABASE_URL"),
  requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { persistSession: false, autoRefreshToken: false } },
);
const adminEmails = list(requireEnv("ADMIN_EMAILS")).map((e) => e.toLowerCase());
const allowedOrigins = list(process.env.ALLOWED_ORIGINS);

const app = new Hono();

app.use(
  "*",
  cors({
    origin: allowedOrigins,
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Authorization", "Content-Type"],
  }),
);

app.get("/health", (c) => c.json({ ok: true }));

// Semua /admin/* wajib token Supabase milik akun yang ada di ADMIN_EMAILS.
app.use("/admin/*", async (c, next) => {
  const token = c.req.header("Authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) return c.json({ error: "Token tidak ada." }, 401);

  const { data, error } = await supabase.auth.getUser(token);
  const user = data.user;
  if (error || !user?.email) return c.json({ error: "Token tidak valid." }, 401);

  if (!user.email_confirmed_at || !adminEmails.includes(user.email.toLowerCase())) {
    return c.json({ error: "Akun ini bukan admin." }, 403);
  }
  await next();
});

const TEXT_FIELDS = ["name", "category", "specs", "price"] as const;
const URL_FIELDS = ["image", "affiliateUrl"] as const;

type ProductRow = {
  name: string;
  category: string;
  specs: string;
  price: string;
  image: string;
  affiliate_url: string;
};

function parseProduct(body: unknown): { row: ProductRow } | { error: string } {
  if (typeof body !== "object" || body === null) {
    return { error: "Body harus berupa JSON." };
  }
  const input = body as Record<string, unknown>;
  const out: Record<string, string> = {};

  for (const key of [...TEXT_FIELDS, ...URL_FIELDS]) {
    const raw = input[key];
    if (typeof raw !== "string" || raw.trim() === "") {
      return { error: `Field "${key}" wajib diisi.` };
    }
    const value = raw.trim();
    if (value.length > 500) return { error: `Field "${key}" terlalu panjang.` };
    out[key] = value;
  }

  for (const key of URL_FIELDS) {
    try {
      const url = new URL(out[key]);
      if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error();
    } catch {
      return { error: `Field "${key}" harus berupa URL http(s).` };
    }
  }

  return {
    row: {
      name: out.name,
      category: out.category,
      specs: out.specs,
      price: out.price,
      image: out.image,
      affiliate_url: out.affiliateUrl,
    },
  };
}

type DbProduct = ProductRow & { id: string };
const toProduct = ({ affiliate_url, ...rest }: DbProduct) => ({
  ...rest,
  affiliateUrl: affiliate_url,
});

const COLUMNS = "id, name, category, specs, price, image, affiliate_url";

const BUCKET = "product-images";
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const IMAGE_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

app.post("/admin/upload", async (c) => {
  const body = await c.req.parseBody().catch(() => null);
  const file = body?.["file"];
  if (!file || typeof file === "string") {
    return c.json({ error: "File gambar tidak ada." }, 400);
  }

  const ext = IMAGE_EXT[file.type];
  if (!ext) return c.json({ error: "Format harus JPG, PNG, atau WebP." }, 400);
  if (file.size > MAX_IMAGE_BYTES) {
    return c.json({ error: "Ukuran gambar maksimal 2 MB." }, 400);
  }

  const path = `${randomUUID()}.${ext}`;
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(path, file, { contentType: file.type, cacheControl: "31536000" });
  if (error) return c.json({ error: error.message }, 500);

  const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
  return c.json({ url: data.publicUrl }, 201);
});

app.post("/admin/products", async (c) => {
  const parsed = parseProduct(await c.req.json().catch(() => null));
  if ("error" in parsed) return c.json({ error: parsed.error }, 400);

  const { data, error } = await supabase
    .from("products")
    .insert({ id: randomUUID(), ...parsed.row })
    .select(COLUMNS)
    .single();

  if (error) return c.json({ error: error.message }, 500);
  return c.json(toProduct(data as DbProduct), 201);
});

app.put("/admin/products/:id", async (c) => {
  const parsed = parseProduct(await c.req.json().catch(() => null));
  if ("error" in parsed) return c.json({ error: parsed.error }, 400);

  const { data, error } = await supabase
    .from("products")
    .update(parsed.row)
    .eq("id", c.req.param("id"))
    .select(COLUMNS)
    .maybeSingle();

  if (error) return c.json({ error: error.message }, 500);
  if (!data) return c.json({ error: "Produk tidak ditemukan." }, 404);
  return c.json(toProduct(data as DbProduct));
});

app.delete("/admin/products/:id", async (c) => {
  const { error } = await supabase
    .from("products")
    .delete()
    .eq("id", c.req.param("id"));

  if (error) return c.json({ error: error.message }, 500);
  return c.json({ ok: true });
});

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port }, () => {
  console.log(`burnodrone-api berjalan di port ${port}`);
});

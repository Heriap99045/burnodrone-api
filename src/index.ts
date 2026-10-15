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

// ---------------------------------------------------------------------------
// Artikel
// ---------------------------------------------------------------------------

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ARTICLE_COLUMNS =
  "id, slug, title, excerpt, category, image, content, published, published_at, created_at, updated_at";

type ArticleInput = {
  slug: string;
  title: string;
  excerpt: string;
  category: string;
  image: string;
  content: string;
  published: boolean;
};

type ArticleRow = ArticleInput & {
  id: string;
  published_at: string | null;
  created_at: string;
  updated_at: string;
};

function parseArticle(body: unknown): { row: ArticleInput } | { error: string } {
  if (typeof body !== "object" || body === null) {
    return { error: "Body harus berupa JSON." };
  }
  const input = body as Record<string, unknown>;

  const limits: [keyof ArticleInput, number][] = [
    ["title", 200],
    ["slug", 120],
    ["category", 100],
    ["excerpt", 500],
    ["content", 100_000],
  ];
  const out: Record<string, string> = {};
  for (const [key, max] of limits) {
    const raw = input[key];
    if (typeof raw !== "string" || raw.trim() === "") {
      return { error: `Field "${key}" wajib diisi.` };
    }
    const value = raw.trim();
    if (value.length > max) return { error: `Field "${key}" terlalu panjang.` };
    out[key] = value;
  }

  if (!SLUG_RE.test(out.slug)) {
    return { error: 'Slug hanya boleh huruf kecil, angka, dan tanda "-".' };
  }

  let image = "";
  if (input.image !== undefined && input.image !== null && input.image !== "") {
    if (typeof input.image !== "string" || input.image.length > 500) {
      return { error: 'Field "image" tidak valid.' };
    }
    try {
      const url = new URL(input.image.trim());
      if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error();
      image = input.image.trim();
    } catch {
      return { error: 'Field "image" harus berupa URL http(s).' };
    }
  }

  return {
    row: {
      slug: out.slug,
      title: out.title,
      excerpt: out.excerpt,
      category: out.category,
      image,
      content: out.content,
      published: input.published === true,
    },
  };
}

const toArticle = (r: ArticleRow) => ({
  id: r.id,
  slug: r.slug,
  title: r.title,
  excerpt: r.excerpt,
  category: r.category,
  image: r.image,
  content: r.content,
  published: r.published,
  publishedAt: r.published_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

// Memicu build ulang situs publik (Vercel Deploy Hook) agar artikel baru tampil.
// Opsional: jika VERCEL_DEPLOY_HOOK_URL kosong, tidak ada yang dipicu.
async function triggerRebuild(): Promise<boolean> {
  const hook = process.env.VERCEL_DEPLOY_HOOK_URL;
  if (!hook) return false;
  try {
    const res = await fetch(hook, {
      method: "POST",
      signal: AbortSignal.timeout(8000),
    });
    return res.ok;
  } catch (err) {
    console.warn("Gagal memicu build ulang:", err);
    return false;
  }
}

app.get("/admin/articles", async (c) => {
  const { data, error } = await supabase
    .from("articles")
    .select(ARTICLE_COLUMNS)
    .order("created_at", { ascending: false });

  if (error) return c.json({ error: error.message }, 500);
  return c.json((data as ArticleRow[]).map(toArticle));
});

app.post("/admin/articles", async (c) => {
  const parsed = parseArticle(await c.req.json().catch(() => null));
  if ("error" in parsed) return c.json({ error: parsed.error }, 400);

  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("articles")
    .insert({
      ...parsed.row,
      published_at: parsed.row.published ? now : null,
      updated_at: now,
    })
    .select(ARTICLE_COLUMNS)
    .single();

  if (error) {
    if (error.code === "23505") {
      return c.json({ error: "Slug sudah dipakai artikel lain." }, 409);
    }
    return c.json({ error: error.message }, 500);
  }

  const rebuild = parsed.row.published ? await triggerRebuild() : false;
  return c.json({ ...toArticle(data as ArticleRow), rebuild }, 201);
});

app.put("/admin/articles/:id", async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) return c.json({ error: "Artikel tidak ditemukan." }, 404);

  const parsed = parseArticle(await c.req.json().catch(() => null));
  if ("error" in parsed) return c.json({ error: parsed.error }, 400);

  const { data: existing, error: findError } = await supabase
    .from("articles")
    .select("published, published_at")
    .eq("id", id)
    .maybeSingle();
  if (findError) return c.json({ error: findError.message }, 500);
  if (!existing) return c.json({ error: "Artikel tidak ditemukan." }, 404);

  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("articles")
    .update({
      ...parsed.row,
      published_at:
        parsed.row.published && !existing.published_at ? now : existing.published_at,
      updated_at: now,
    })
    .eq("id", id)
    .select(ARTICLE_COLUMNS)
    .single();

  if (error) {
    if (error.code === "23505") {
      return c.json({ error: "Slug sudah dipakai artikel lain." }, 409);
    }
    return c.json({ error: error.message }, 500);
  }

  // Build ulang hanya jika konten publik berubah (sebelumnya atau sesudahnya terbit).
  const rebuild =
    existing.published || parsed.row.published ? await triggerRebuild() : false;
  return c.json({ ...toArticle(data as ArticleRow), rebuild });
});

app.delete("/admin/articles/:id", async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) return c.json({ error: "Artikel tidak ditemukan." }, 404);

  const { data: existing, error: findError } = await supabase
    .from("articles")
    .select("published")
    .eq("id", id)
    .maybeSingle();
  if (findError) return c.json({ error: findError.message }, 500);
  if (!existing) return c.json({ error: "Artikel tidak ditemukan." }, 404);

  const { error } = await supabase.from("articles").delete().eq("id", id);
  if (error) return c.json({ error: error.message }, 500);

  const rebuild = existing.published ? await triggerRebuild() : false;
  return c.json({ ok: true, rebuild });
});

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port }, () => {
  console.log(`burnodrone-api berjalan di port ${port}`);
});

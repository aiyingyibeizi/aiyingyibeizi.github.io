import base64, re, os, shutil, urllib.request, urllib.parse, sys, concurrent.futures, time

PROMPTS = [
    "Stunning abstract album cover art, glowing purple sphere made of faceted glass and crystal layers, soft gradient background, cinematic lighting, highly detailed, no text, masterpiece",
    "Epic mountain lake at sunrise, snow peak reflections in calm water, pink orange clouds, misty forest, cinematic landscape, album cover art, no text",
    "Luxury wooden geometric mosaic, rich oak and walnut texture, golden brass accents, intricate art deco pattern, album cover design, warm tones, no text",
    "Vinyl record player glowing with neon pink and cyan lights, retro synthwave aesthetic, music album cover art, cinematic, no text",
    "Aurora borealis over frozen lake, milky way galaxy, snow covered mountains, magical cinematic landscape, highly detailed, album cover art, no text",
    "Abstract fluid art with emerald green and liquid gold, marble texture, luxury background, album cover design, no text",
    "Cyberpunk city skyline at sunset, neon reflections on wet streets, futuristic album cover art, cinematic, highly detailed, no text",
    "Tropical beach with turquoise water, white sand, palm tree shadows, golden hour sunlight, cinematic travel album cover, no text",
    "Minimalist brutalist architecture, dramatic geometric shadows, blue sky, modern art photography, album cover style, no text",
    "Starry night sky over mountain silhouette, milky way core, deep blue and purple, cosmic art, album cover design, no text",
    "3D abstract geometric shapes made of glass and chrome floating in soft pastel gradient space, modern digital art, album cover, no text",
    "Cherry blossom trees along a calm river at dusk, pink petals falling, dreamy cinematic atmosphere, album cover art, no text",
    "Desert sand dunes at golden hour, smooth curves, warm amber and ivory tones, minimalist landscape, album cover style, no text",
    "Retro cassette tape on vibrant geometric background, 80s synthwave aesthetic, music album cover art, cinematic lighting, no text",
    "Lush green rice terraces aerial view, tropical landscape, vibrant agriculture, cinematic album cover, no text",
    "Abstract copper and wood texture, geometric inlay pattern, warm industrial luxury design, album cover art, no text",
    "Modern city skyline at dusk with reflections in water, purple orange sky, urban landscape photography, album cover, no text",
    "Golden wheat field under deep blue sky with dramatic clouds, cinematic landscape, warm sunlight, album cover art, no text",
    "Abstract paper cut layered landscape, rolling hills and sun, warm pastel colors, craft art, album cover design, no text",
    "Neon synthwave sunset with grid floor and palm trees, retro futuristic album cover art, vibrant pink purple, no text",
    "Macro close up of green fern leaves with dewdrops, fresh nature, soft bokeh background, botanical album cover art, no text",
    "Abstract gradient waves, soft pink blue purple, digital art, smooth flowing shapes, modern album cover, no text",
    "Majestic red rock canyon with river and dramatic clouds, American southwest landscape, cinematic album cover, no text",
    "Geometric marble and gold abstract composition, luxury minimalist art, clean shapes, album cover design, no text",
    "Minimalist coffee cup on marble table, morning golden light, clean lifestyle photography, album cover style, no text",
    "Colorful hot air balloons over Cappadocia rock formations at sunrise, travel photography, cinematic album cover, no text",
    "Abstract digital crystal formation, iridescent facets, dark background, futuristic album cover art, highly detailed, no text",
    "Autumn forest path with red and orange leaves, sunlight through trees, cozy cinematic landscape, album cover, no text",
    "Japanese zen garden with rocks and raked sand patterns, peaceful green moss, minimal art, album cover style, no text",
    "Vibrant sunset over ocean waves, orange pink purple sky, silhouette of distant islands, cinematic album cover art, no text",
]

os.makedirs('assets/avatars', exist_ok=True)

headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}
base = "https://image.pollinations.ai/prompt/"

def download_one(args):
    i, prompt = args
    out = f"assets/avatars/avatar_{i:02d}.jpg"
    if os.path.exists(out):
        os.remove(out)
    url = f"{base}{urllib.parse.quote(prompt)}?width=1024&height=1024&nologo=true&seed={i + 1000}"
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = resp.read()
        with open(out, 'wb') as f:
            f.write(data)
        size = os.path.getsize(out)
        return (i, out, f"ok {size}")
    except Exception as e:
        return (i, None, str(e))

results = []
with concurrent.futures.ThreadPoolExecutor(max_workers=3) as executor:
    for r in executor.map(download_one, enumerate(PROMPTS, 1)):
        results.append(r)
        print(f"avatar_{r[0]:02d}: {r[2]}")

failed = [r for r in results if r[1] is None]
if failed:
    print(f"Initial failed downloads: {len(failed)}, retrying...")
    for r in failed:
        i = r[0]
        prompt = PROMPTS[i - 1]
        out = f"assets/avatars/avatar_{i:02d}.jpg"
        url = f"{base}{urllib.parse.quote(prompt)}?width=1024&height=1024&nologo=true&seed={i + 1000}"
        for attempt in range(5):
            req = urllib.request.Request(url, headers=headers)
            try:
                with urllib.request.urlopen(req, timeout=120) as resp:
                    data = resp.read()
                with open(out, 'wb') as f:
                    f.write(data)
                print(f"avatar_{i:02d} retry ok {len(data)}")
                break
            except Exception as e:
                print(f"avatar_{i:02d} retry {attempt+1} failed: {e}")
                time.sleep(5)
        else:
            print(f"avatar_{i:02d} giving up")

urls = [f"assets/avatars/avatar_{i:02d}.jpg?v=2" for i in range(1, 31)]
js_array = "  // ===== 预设头像：30 张精选艺术风景 / 几何 / 木纹 / 专辑封面风格头像（本地文件，不占用数据库存储）=====\n  const PRESET_AVATARS = [\n" + ",\n".join(f"    {{ id: {i}, url: '{u}' }}" for i, u in enumerate(urls)) + "\n  ];\n"

with open('/workspace/cesi/js/common.js', 'r', encoding='utf-8') as f:
    content = f.read()

pattern = re.compile(r"  // ===== 预设头像.*?const PRESET_AVATARS = \[.*?\];", re.S)
if pattern.search(content):
    content = pattern.sub(js_array.rstrip(), content)
    print("Replaced PRESET_AVATARS")
else:
    print("Could not locate PRESET_AVATARS block")
    sys.exit(1)

with open('/workspace/cesi/js/common.js', 'w', encoding='utf-8') as f:
    f.write(content)

print("Done")

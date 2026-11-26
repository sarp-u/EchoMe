# EchoMe'yi internete açma

Bu proje yerel bir model (Chatterbox, ~3 GB) çalıştırır. Ücretsiz sunucularda
**GPU yoktur**; bu yüzden ücretsiz bulut seçeneklerinde üretim Mac'ine göre çok
daha yavaş olur. Aşağıda gerçekçi seçenekler en mantıklısından başlayarak
sıralanmıştır.

> **Güvenlik:** Ses klonlama uç noktasını herkese açık bırakmayın. Her yöntemde
> `ECHOME_PASSWORD` ortam değişkeni ile HTTP Basic şifre koyun. Şifre boşsa
> uygulama korumasızdır (varsayılan yerel kullanım böyledir).
>
> Kullanıcı adı varsayılanı `echome`'dir; `ECHOME_USER` ile değiştirilebilir.
> `/healthz` uç noktası şifre gerektirmez.

## Seçenek 1 — Mac + Cloudflare Tunnel (ücretsiz, en hızlı)

Model Mac'inde, MPS ile çalışmaya devam eder; sadece dışarıya bir HTTPS tüneli
açılır. Ekstra bulut maliyeti yoktur. Bilgisayar açık ve uyanık kalmalıdır.

```bash
brew install cloudflared
cd ~/Desktop/Chatter
ECHOME_PASSWORD='güçlü-bir-şifre' ./run.sh       # 127.0.0.1:8760
```

İkinci bir terminalde:

```bash
cloudflared tunnel --url http://127.0.0.1:8760
```

Çıktıdaki `https://rastgele-ad.trycloudflare.com` adresi dünyaya açıktır; şifre
sorulur. Bu ücretsiz "quick tunnel" adresi her yeniden başlatmada değişir.

**Kalıcı alan adı** (Cloudflare'de yönetilen bir domain gerektirir):

```bash
cloudflared tunnel login
cloudflared tunnel create echome
cloudflared tunnel route dns echome echome.ornek.com
cloudflared tunnel run --url http://127.0.0.1:8760 echome
```

Alternatifler:

- **Tailscale Funnel**: `brew install tailscale`, `tailscale up`,
  `tailscale funnel 8760` (kalıcı `*.ts.net` adresi).
- **ngrok**: ücretsiz hesap + `ngrok http 8760` (rastgele adres).

Mac'in uyumaması için: `caffeinate -dimsu` ile çalıştırın veya Güç
Ayarları'ndan uykuyu kapatın. Kapak kapanınca yayın durur.

## Seçenek 2 — Hugging Face Spaces (CPU, PRO gerekir)

> **Güncel HF politikası:** Yeni **Gradio veya Docker** Space oluşturmak ücretli
> plan gerektirir (kişisel hesap için **PRO, $9/ay**). Ücretsiz hesaplar
> yalnızca **2 adet Gradio ZeroGPU Space** açabilir. Bu proje Docker + FastAPI
> olduğu için ücretsiz hesapla yayınlanamaz.

CPU Basic donanımı 2 vCPU / 16 GB RAM / 50 GB geçici disk sunar. Bu uygulama
için performans beklentisi:

| İşlem | CPU Basic (2 vCPU) | Mac (M1, MPS) |
| --- | --- | --- |
| Modelin yüklenmesi | ~1–3 dakika | ~20–60 saniye |
| 5–6 saniyelik kısa cümle | ~1–2 dakika | ~25–50 saniye |
| 30 saniyelik metin | ~6–10 dakika | ~2–4 dakika |
| Eşzamanlı kullanıcı | 1 (kuyruk) | 1 (kuyruk) |

> Ölçüm notu: M1 üzerinde **2 thread** ile 4.8 saniyelik ses 34.5 saniyede
> üretildi (7.2× gerçek zaman). HF'nin 2 vCPU Xeon çekirdekleri tek çekirdekte
> kabaca 1.5–2.5× daha yavaş olduğundan yukarıdaki aralıklar tahminidir;
> gerçek süre Space'in yüküne göre değişir.

Yani çalışır ama **demo için bile sabır ister**. Ayrıca:

- Space'ler **herkese açıktır** → `ECHOME_PASSWORD` şart.
- Disk geçicidir: Space yeniden başlarsa üretim geçmişi silinir.
- Hareketsizlikten sonra uyur; ilk istekte yeniden açılış + model yükleme gerekir.
- Uzun metinler tek kullanıcı tarafından dakikalarca kuyruğu bloke eder.

### Adımlar

1. https://huggingface.co/new-space → **SDK: Docker**, **Hardware: CPU basic**,
   görünürlük: Public. (Space oluşturmak için PRO hesap gerekir.)
2. Space deposunu klonlayın ve proje dosyalarını kopyalayın:

```bash
git clone https://huggingface.co/spaces/KULLANICI/echome
cd echome
cp -R ~/Desktop/Chatter/server.py \
      ~/Desktop/Chatter/static \
      ~/Desktop/Chatter/requirements.txt \
      ~/Desktop/Chatter/Dockerfile \
      ~/Desktop/Chatter/.dockerignore .
```

3. Space'in `README.md` dosyasının en üstünde şu frontmatter olmalı
   (Hugging Face bunu şablon olarak oluşturur; `app_port` mutlaka 8760):

```yaml
---
title: EchoMe
emoji: 🎙️
colorFrom: red
colorTo: yellow
sdk: docker
app_port: 8760
pinned: false
---
```

> Space açıldığında tarayıcı sizden kullanıcı adı ve şifre ister. Kullanıcı adı
> `echome` (veya `ECHOME_USER`), şifre ise `ECHOME_PASSWORD` olarak
> belirlediğiniz değerdir.

4. Space → **Settings → Variables and secrets**:

   - Secret `ECHOME_PASSWORD` = güçlü şifre
   - İsteğe bağlı Secret `ECHOME_USER` = `echome`
   - İsteğe bağlı Variable `CHATTERBOX_DEVICE` = `cpu`

5. Push edin:

```bash
git add .
git commit -m "EchoMe"
git push
```

Hugging Face kullanıcı adı + **write** yetkili access token ister (parola
yerine token girin).

6. Build bittiğinde uygulama `https://KULLANICI-echome.hf.space` adresinde olur.

### Notlar

- `Dockerfile`, model ağırlıklarını imaja gömer; ilk build 15–40 dakika
  sürebilir ve imaj ~6–7 GB olur. Build limitine takılırsa Dockerfile'daki
  `snapshot_download` satırını kaldırın: model ilk açılışta indirilir (cold
  start daha uzun olur).
- Space uyandığında modelin CPU'da yüklenmesi 1–3 dakika sürebilir; arayüz
  "Model yükleniyor" durumunda bekler.
- Uzun metinlerde CPU üretimi çok uzun sürebilir; demo için kısa metinler
  kullanın.
- Ücretsiz görünürlükte özel (private) Space yoktur; erişimi şifre korur.

### Daha hızlı HF alternatifleri

| Donanım | Fiyat | Bu uygulama için |
| --- | --- | --- |
| CPU Basic (2 vCPU) | PRO $9/ay | Çalışır, çok yavaş |
| CPU Upgrade (8 vCPU) | ~$0.03/saat (~$22/ay) | ~3–4× daha hızlı, hâlâ yavaş |
| Nvidia T4 small | ~$0.40/saat (~$288/ay) | Hızlı, hobbi için pahalı |
| **ZeroGPU** (RTX Pro 6000) | Ücretsiz 5 dk/gün, PRO 40 dk/gün | Çok hızlı ama **yalnızca Gradio** |

**ZeroGPU** cazip görünse de bu proje için doğrudan uyumlu değil:

- ZeroGPU yalnızca **Gradio SDK** ile çalışır; mevcut FastAPI + özel HTML
  arayüzü çalışmaz. Gradio sarmalayıcı yazmak gerekir.
- ZeroGPU **PyTorch ≥ 2.8** destekler; Chatterbox 0.1.7 ise `torch==2.6.0`
  sabitler. Sürüm yükseltmesi test edilmeden garanti değildir.
- Ücretsiz hesap günde **5 dakika**, PRO **40 dakika** GPU kotası verir; kota
  dolunca kuyruk/limit devreye girer.

Kısacası: **kalıcı ve ücretsiz** bir kurulum arıyorsan Mac + Cloudflare Tunnel
en iyi seçenek. HF Spaces ancak PRO aboneliğiyle ve "yavaş demo" beklentisiyle
mantıklı.

## Seçenek 3 — Google Colab / Kaggle + tünel (ücretsiz GPU, geçici demo)

Kalıcı değildir; oturum kapanınca URL ölür. Ama ücretsiz GPU (Colab'da T4) ile
hızlı bir demo için iyidir. Projeyi Colab'a yükleyin (veya GitHub'a atıp
klonlayın), sonra:

```python
!git clone https://github.com/KULLANICI/echome.git /content/echome
%cd /content/echome
!pip install -q -r requirements.txt
!apt-get -qq install -y ffmpeg

!ECHOME_PASSWORD='güçlü-bir-şifre' nohup python -m uvicorn server:app --host 0.0.0.0 --port 8760 > /content/echome.log 2>&1 &

!wget -q https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -O /usr/local/bin/cloudflared
!chmod +x /usr/local/bin/cloudflared
!cloudflared tunnel --url http://127.0.0.1:8760
```

Son hücre çıktısındaki `https://....trycloudflare.com` adresini açın. Hücreyi
kapatmayın. Colab ücretsiz oturumları uzun süre boş kalınca veya ~12 saat
sonunda kapanır.

## Seçenek 4 — Modal (ücretsiz GPU kredisi)

Modal aylık ücretsiz kredi verir ve sunucusuz GPU (T4/A10G) çalıştırır. Bu
projeyi olduğu gibi taşımak için:

- Kalıcı çıktılar ve model önbelleği için bir Modal **Volume** bağlayın.
- Uygulamayı `modal.asgi_app()` ile sarmalayın, `gpu="T4"` seçin.
- Uzun üretimler için zaman aşımını artırın (`timeout=1800`).
- İş kuyruğu bellekte tutulduğu için konteyner kapanınca yarım işler kaybolur;
  demo için tek konteyner ve `min_containers=0` yeterlidir.

Bu seçenek biraz kod gerektirir; isterseniz `modal_app.py` olarak hazırlanabilir.

## Uygun olmayan ücretsiz platformlar

- **Vercel / Netlify / Cloudflare Pages**: yalnızca statik site barındırır;
  Python + torch + model çalıştıramaz.
- **Render / Koyeb ücretsiz katmanları**: 512 MB–1 GB RAM ve çok az CPU;
  model yüklenemez.
- **Railway**: kalıcı ücretsiz katman yoktur (deneme kredisi).
- **Fly.io**: ücretsiz GPU yoktur; model belleği ücretli makine gerektirir.

Bu yüzden gerçek ücretsiz seçenekler: **Mac + tünel**, **HF Spaces CPU** veya
**Colab/Modal GPU (geçici/kotalı)**.

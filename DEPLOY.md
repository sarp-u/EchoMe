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

## Seçenek 2 — Hugging Face Spaces (ücretsiz kalıcı URL, CPU)

Ücretsiz CPU Space yaklaşık 2 vCPU / 16 GB RAM sunar. Kalıcı bir URL alırsınız
ama:

- CPU'da üretim **dakikalar** sürebilir (Mac'teki MPS'e göre çok yavaş).
- Ücretsiz Space'ler **herkese açıktır** → `ECHOME_PASSWORD` şart.
- Disk geçicidir: Space yeniden başlarsa üretim geçmişi silinir.
- Ücretsiz Space'ler hareketsizlikten sonra uyur; ilk istekte yeniden açılış +
  model yükleme gerekir.

### Adımlar

1. https://huggingface.co/new-space → **SDK: Docker**, **Hardware: CPU basic**
   (ücretsiz), görünürlük: Public.
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
- Space uyandığında modelin CPU'da yüklenmesi 1–2 dakika sürebilir; arayüz
  "Model yükleniyor" durumunda bekler.
- Uzun metinlerde CPU üretimi çok uzun sürebilir; demo için kısa metinler
  kullanın.
- Ücretsiz Space'te özel (private) görünürlük yoktur; erişimi şifre korur.

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

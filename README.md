# Subathon Extensible (TikTok + Kick)

## 1) Instalar
```bash
cd subathon
cp .env.example .env   # edita usuario TikTok y canal Kick
npm install
npm start              # levanta ws en el puerto 8080
```
## 2) Overlay en OBS
Sirve `overlay/index.html` (nginx o live-server) y en OBS añade un "Navegador":
```
http://TU-SERVIDOR/overlay/index.html?ws=ws://TU-SERVIDOR:8080
```
## 3) Reglas
Edita `rules.json` para definir cuántos segundos suma cada regalo/sub.

## 4) Servidor RTMP con standby
Usa `nginx.conf.example` como guía. Coloca un video `/var/media/standby/standby.mp4`.
Cuando se cae la señal, el standby mantiene el directo en vivo.
```
sudo nginx -t && sudo systemctl restart nginx
```
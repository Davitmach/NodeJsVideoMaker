// bot.js — Node 18+ (ES‑modules)
import { Telegraf } from "telegraf";
import axios from "axios";
import dotenv from "dotenv";
import fs from "fs/promises";
import path from "path";
import jwt from "jsonwebtoken";

dotenv.config();

const { BOT_TOKEN, KLING_ACCESS_KEY, KLING_SECRET_KEY } = process.env;
const API_BASE = "https://api-singapore.klingai.com";

const bot = new Telegraf(BOT_TOKEN /*, { handlerTimeout: 0 }*/);

const TMP = path.resolve("./tmp");
await fs.mkdir(TMP, { recursive: true });

const getJwt = () => {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    { iss: KLING_ACCESS_KEY, iat: now, nbf: now - 5, exp: now + 1800 },
    KLING_SECRET_KEY,
    { algorithm: "HS256", header: { alg: "HS256", typ: "JWT" } }
  );
};

bot.start((ctx) =>
  ctx.reply("👋 Отправь фото с подписью — сделаю видео через Kling AI.")
);

bot.on("photo", async (ctx) => {
  const prompt = ctx.message.caption?.trim();
  if (!prompt) return ctx.reply("Добавь текст‑промпт в подписи к фото.");

  const photo = ctx.message.photo.at(-1);
  const link = await ctx.telegram.getFileLink(photo.file_id);
  const tempFile = path.join(TMP, `${photo.file_unique_id}.jpg`);

  await ctx.reply("🔄 Генерирую видео, подождите…");

  (async () => {
    try {
      /* 1. Скачиваем фото (тайм‑аут 10 мин) */
      const { data: imgBuf } = await axios.get(link.href, {
        responseType: "arraybuffer",
        timeout: 600_000,          // 10 мин
      });
      await fs.writeFile(tempFile, imgBuf);

      /* 2. Создаём задачу */
      const token = getJwt();
      const body = {
        model_name: "kling-v1-6",
        mode: "pro",
        duration: "5",
        auto_prompt: false,
        prompt,
        image: imgBuf.toString("base64"),
        cfg_scale: 0.5,
      };

      const { data: gen } = await axios.post(
        `${API_BASE}/v1/videos/image2video`,
        body,
        { headers: { Authorization: `Bearer ${token}` }, timeout: 600_000 }
      );
      const taskId = gen?.data?.task_id;
      if (!taskId)
        return ctx.reply("❌ Не удалось создать задачу на стороне Kling AI.");

      /* 3. Poll до 10 минут (60 итераций × 10 с) */
      let videoUrl;
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 10_000));

        const { data: check } = await axios.get(
          `${API_BASE}/v1/videos/image2video/${taskId}`,
          { headers: { Authorization: `Bearer ${token}` }, timeout: 600_000 }
        );

        const status = check?.data?.task_status;
        if (status === "succeed") {
          videoUrl =
            check.data.task_result?.video_url ||
            check.data.task_result?.videos?.[0]?.url;
          break;
        }
        if (status === "failed")
          return ctx.reply("❌ Kling AI вернул status=failed. Попробуйте другой промпт.");
      }

      if (!videoUrl)
        return ctx.reply("⚠️ Видео не успело сгенерироваться за 10 минут.");

      /* 4. Отправляем видео */
      await ctx.replyWithVideo({ url: videoUrl }, { caption: "✅ Готово!" });
    } catch (err) {
      console.error("Ошибка фоновой задачи:", err?.response?.data || err);
      ctx.reply("❌ Ошибка при генерации видео.");
    } finally {
      await fs.rm(tempFile, { force: true }).catch(() => {});
    }
  })();
});

bot.launch().then(() => console.log("🤖 Bot started"));
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));

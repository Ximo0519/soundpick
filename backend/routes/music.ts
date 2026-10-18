import { Router, Request, Response } from 'express';
import { eq, and, desc, sql } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { db, isDbConfigured } from '../db';
import { music, users } from '../db/schema';
import { requireAuth } from '../middleware/auth';
import { createAIService } from '../services/aiService';
import {
  createGenerationTask,
  getTaskResult,
  downloadAudio,
  isSunoConfigured,
} from '../services/sunoService';
import { uploadAudio, deleteAudio, getDownloadUrl, isR2Configured } from '../services/r2Service';

const router = Router();

// ============ 内部工具 ============

/** 调 DeepSeek 把用户描述扩写为 Suno 可用的英文提示词 */
async function optimizePrompt(
  prompt: string,
  style: string,
  mood: string,
): Promise<{ title: string; sunoPrompt: string; tags: string; mood: string }> {
  const ai = createAIService();
  const systemPrompt = `You are a professional Suno AI music prompt engineer. Based on the user's Chinese music description, produce:
1. "title": a poetic Chinese music title (2-8 characters)
2. "sunoPrompt": a vivid English music prompt for Suno (1-3 sentences, describing genre, instruments, tempo, atmosphere)
3. "tags": comma-separated English style tags (3-6 tags, e.g. "lofi, jazz, piano, relaxing")
4. "mood": the actual mood of this music in Chinese (one word, e.g. 欢快/平静/悲伤/激昂/神秘/温馨)
Respond ONLY with JSON: {"title":"...","sunoPrompt":"...","tags":"...","mood":"..."}`;

  const userMessage = `描述: ${prompt}\n风格: ${style || '不限'}\n情绪: ${mood || '不限'}`;

  const raw = await ai.chat(userMessage, systemPrompt);
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        title: parsed.title || '未命名音乐',
        sunoPrompt: parsed.sunoPrompt || prompt,
        tags: parsed.tags || style || '',
        mood: parsed.mood || mood || '',
      };
    }
  } catch {
    // 解析失败走兜底
  }
  return { title: '未命名音乐', sunoPrompt: prompt, tags: style || '', mood: mood || '' };
}

/**
 * 后台双版本生成：各自轮询 → 下载音频 → 转存 R2 → 更新数据库
 * 两个版本并行轮询（同一个 async 函数里串行处理两个 taskId）
 *
 * @param recordIds  两条 music 记录的数据库 id
 * @param userId     操作用户 id（用于 R2 存储路径 + 失败退配额）
 * @param quotaCost  本次生成消耗的配额（失败时退回）
 */
async function runGenerationDual(
  recordIds: [number, number],
  userId: number,
  quotaCost: number,
) {
  const MAX_POLLS = 60; // 每 6 秒一次，最多 6 分钟
  let anySuccess = false;
  let anyFailed = false;

  // 两条记录各自处理
  for (const recordId of recordIds) {
    try {
      const rows = await db.select().from(music).where(eq(music.id, recordId)).limit(1);
      const record = rows[0];
      if (!record || !record.sunoTaskId) {
        console.error(`[music:${recordId}] 记录或 taskId 不存在`);
        anyFailed = true;
        continue;
      }

      let clip: Awaited<ReturnType<typeof getTaskResult>>['clips'][0] | null = null;
      let finalStatus: 'completed' | 'failed' | 'generating' = 'generating';
      let failReason = '';

      for (let i = 0; i < MAX_POLLS; i++) {
        await new Promise((r) => setTimeout(r, 6000));

        const result = await getTaskResult(record.sunoTaskId);

        if (result.status === 'completed' && result.clips.length > 0) {
          clip = result.clips[0];
          finalStatus = 'completed';
          break;
        }
        if (result.status === 'failed') {
          finalStatus = 'failed';
          failReason = result.failReason || 'Suno 生成失败';
          break;
        }
      }

      if (finalStatus === 'generating') {
        // 超时
        finalStatus = 'failed';
        failReason = '生成超时（6 分钟），请稍后重试';
      }

      if (finalStatus === 'failed') {
        anyFailed = true;
        await db
          .update(music)
          .set({ status: 'failed', failReason: failReason.slice(0, 500) })
          .where(eq(music.id, recordId));
        console.error(`[music:${recordId}] 失败: ${failReason}`);
        continue;
      }

      // completed
      if (!clip?.audioUrl) {
        anyFailed = true;
        await db
          .update(music)
          .set({ status: 'failed', failReason: '完成但未获取到音频地址' })
          .where(eq(music.id, recordId));
        continue;
      }

      // 无 R2 配置时直接用临时 URL
      if (!isR2Configured()) {
        await db
          .update(music)
          .set({
            status: 'completed',
            audioUrl: clip.audioUrl,
            sunoId: clip.sunoId || null,
            duration: clip.duration || null,
            completedAt: new Date(),
          })
          .where(eq(music.id, recordId));
        anySuccess = true;
        console.warn(`[music:${recordId}] R2 未配置，使用 Suno 临时 URL`);
        continue;
      }

      // 下载 + 转存 R2
      const buffer = await downloadAudio(clip.audioUrl);
      const { key, publicUrl } = await uploadAudio(userId, buffer);

      await db
        .update(music)
        .set({
          status: 'completed',
          audioUrl: publicUrl,
          r2Key: key,
          sunoId: clip.sunoId || null,
          duration: clip.duration || null,
          completedAt: new Date(),
        })
        .where(eq(music.id, recordId));

      anySuccess = true;
      console.log(`[music:${recordId}] 完成 → ${publicUrl}`);
    } catch (err) {
      anyFailed = true;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[music:${recordId}] 处理异常:`, msg);
      await db
        .update(music)
        .set({ status: 'failed', failReason: msg.slice(0, 500) })
        .where(eq(music.id, recordId));
    }
  }

  // 两条都失败 → 退配额
  // 有一条成功 → 不退回（用户至少拿到了可用结果）
  if (!anySuccess && anyFailed) {
    console.warn(`[music:group ${recordIds.join(',')}] 双版本均失败，退还配额 -${quotaCost} → +${quotaCost}`);
    try {
      await db
        .update(users)
        .set({ quotaRemaining: sql`${users.quotaRemaining} + ${quotaCost}` })
        .where(eq(users.id, userId));
    } catch (err) {
      console.error('[music] 退配额失败:', err);
    }
  }
}

/** 数据库记录 → 前端格式 */
function toClient(r: typeof music.$inferSelect) {
  return {
    id: String(r.id),
    title: r.title,
    description: r.description,
    prompt: r.prompt,
    optimizedPrompt: r.optimizedPrompt,
    tags: r.tags,
    mood: r.mood,
    instrumental: !!r.instrumental,
    duration: r.duration,
    status: r.status,
    failReason: r.failReason,
    audioUrl: r.audioUrl,
    generationGroup: r.generationGroup,
    createdAt: r.createdAt,
  };
}

// ============ 路由 ============

/** 发起生成：扣配额 → DeepSeek 润色 → 提交 Suno（两个 task_id）→ 插两条记录 → 返回 generationGroup */
router.post('/generate', requireAuth, async (req: Request, res: Response) => {
  try {
    if (!isDbConfigured()) {
      return res.status(503).json({ success: false, error: '数据库未配置' });
    }
    if (!isSunoConfigured()) {
      return res.status(503).json({
        success: false,
        error: '音乐生成服务未配置（SUNO_API_KEY）',
      });
    }

    const { prompt, style, mood, instrumental } = req.body;
    if (!prompt || !String(prompt).trim()) {
      return res.status(400).json({ success: false, error: '请输入音乐描述' });
    }

    const user = req.authUser!;
    if (user.quotaRemaining <= 0) {
      return res
        .status(429)
        .json({ success: false, error: '今日生成次数已用完，明天再来吧' });
    }

    // DeepSeek 润色
    let title = '未命名音乐';
    let sunoPrompt = String(prompt).trim();
    let tags = String(style || '');
    let actualMood = String(mood || '');
    let polishFailed = false;
    try {
      const optimized = await optimizePrompt(
        String(prompt).trim(),
        String(style || ''),
        String(mood || ''),
      );
      title = optimized.title;
      sunoPrompt = optimized.sunoPrompt;
      tags = optimized.tags;
      actualMood = optimized.mood;
    } catch (err) {
      polishFailed = true;
      console.warn('[music] DeepSeek 润色失败，使用原始描述:', err);
    }

    // 提交 Suno → 两个 task_id
    const { taskIds } = await createGenerationTask({
      prompt: sunoPrompt,
      title,
      instrumental: instrumental !== false,
    });

    // 扣配额 + 生成分组 UUID
    const quotaCost = 1;
    await db
      .update(users)
      .set({ quotaRemaining: user.quotaRemaining - quotaCost })
      .where(eq(users.id, user.id));

    const groupId = randomUUID();

    // 插入两条 music 记录（共享 generationGroup）
    const baseValues = {
      userId: user.id,
      title,
      description: String(prompt).trim(),
      prompt: String(prompt).trim(),
      optimizedPrompt: sunoPrompt,
      tags,
      mood: actualMood,
      instrumental: instrumental === false ? 0 : 1,
      status: 'generating' as const,
      generationGroup: groupId,
    };

    const [v1, v2] = await db
      .insert(music)
      .values([
        { ...baseValues, sunoTaskId: taskIds[0] },
        { ...baseValues, sunoTaskId: taskIds[1] },
      ])
      .returning();

    // 启动后台任务
    void runGenerationDual([v1.id, v2.id], user.id, quotaCost);

    return res.json({
      success: true,
      data: {
        groupId,
        versions: [toClient(v1), toClient(v2)],
        quotaRemaining: user.quotaRemaining - quotaCost,
        polishFailed,
      },
    });
  } catch (err) {
    console.error('[music] generate error:', err);
    const msg = err instanceof Error ? err.message : '发起生成失败';
    return res.status(500).json({ success: false, error: msg });
  }
});

/** 按 generationGroup 批量查询（前端轮询用） */
router.get('/group/:groupId', requireAuth, async (req: Request, res: Response) => {
  try {
    const groupId = String(req.params.groupId).trim();
    if (!groupId) {
      return res.status(400).json({ success: false, error: '请提供 groupId' });
    }
    const rows = await db
      .select()
      .from(music)
      .where(
        and(
          eq(music.generationGroup, groupId as any),
          eq(music.userId, req.authUser!.id),
        ),
      )
      .orderBy(music.id);
    if (rows.length === 0) {
      return res.status(404).json({ success: false, error: '该分组不存在' });
    }
    return res.json({ success: true, data: rows.map(toClient) });
  } catch (err) {
    console.error('[music] group query error:', err);
    return res.status(500).json({ success: false, error: '查询分组失败' });
  }
});

/** 我的音乐列表 */
router.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const rows = await db
      .select()
      .from(music)
      .where(eq(music.userId, req.authUser!.id))
      .orderBy(desc(music.createdAt))
      .limit(200);
    return res.json({ success: true, data: rows.map(toClient) });
  } catch (err) {
    console.error('[music] list error:', err);
    return res.status(500).json({ success: false, error: '获取列表失败' });
  }
});

/** 单条状态（前端轮询用） */
router.get('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const rows = await db
      .select()
      .from(music)
      .where(
        and(
          eq(music.id, parseInt(String(req.params.id), 10)),
          eq(music.userId, req.authUser!.id),
        ),
      )
      .limit(1);
    if (rows.length === 0) {
      return res.status(404).json({ success: false, error: '音乐不存在' });
    }
    return res.json({ success: true, data: toClient(rows[0]) });
  } catch (err) {
    console.error('[music] detail error:', err);
    return res.status(500).json({ success: false, error: '获取详情失败' });
  }
});

/** 重命名 */
router.patch('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const title = String(req.body.title || '').trim().slice(0, 100);
    if (!title) {
      return res.status(400).json({ success: false, error: '标题不能为空' });
    }
    const updated = await db
      .update(music)
      .set({ title })
      .where(
        and(
          eq(music.id, parseInt(String(req.params.id), 10)),
          eq(music.userId, req.authUser!.id),
        ),
      )
      .returning();
    if (updated.length === 0) {
      return res.status(404).json({ success: false, error: '音乐不存在' });
    }
    return res.json({ success: true, data: toClient(updated[0]) });
  } catch (err) {
    console.error('[music] rename error:', err);
    return res.status(500).json({ success: false, error: '重命名失败' });
  }
});

/** 删除（同时删除 R2 文件） */
router.delete('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    const rows = await db
      .select()
      .from(music)
      .where(and(eq(music.id, id), eq(music.userId, req.authUser!.id)))
      .limit(1);
    if (rows.length === 0) {
      return res.status(404).json({ success: false, error: '音乐不存在' });
    }

    const record = rows[0];
    if (record.r2Key) {
      await deleteAudio(record.r2Key);
    }
    await db.delete(music).where(eq(music.id, id));

    return res.json({ success: true, data: { id: String(id) } });
  } catch (err) {
    console.error('[music] delete error:', err);
    return res.status(500).json({ success: false, error: '删除失败' });
  }
});

/** 下载：返回带附件头的 R2 签名 URL */
router.get('/:id/download', requireAuth, async (req: Request, res: Response) => {
  try {
    const rows = await db
      .select()
      .from(music)
      .where(
        and(
          eq(music.id, parseInt(String(req.params.id), 10)),
          eq(music.userId, req.authUser!.id),
        ),
      )
      .limit(1);
    const record = rows[0];
    if (!record) {
      return res.status(404).json({ success: false, error: '音乐不存在' });
    }
    if (record.status !== 'completed' || !record.audioUrl) {
      return res
        .status(400)
        .json({ success: false, error: '音乐尚未生成完成' });
    }

    // 有 R2 Key 用签名 URL（带下载文件名）；否则直接回临时 URL
    if (record.r2Key && isR2Configured()) {
      const url = await getDownloadUrl(record.r2Key, `${record.title}.mp3`);
      return res.json({ success: true, data: { url } });
    }
    return res.json({ success: true, data: { url: record.audioUrl } });
  } catch (err) {
    console.error('[music] download error:', err);
    return res.status(500).json({ success: false, error: '获取下载链接失败' });
  }
});

export default router;

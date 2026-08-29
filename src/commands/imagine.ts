/**
 * ── /imagine 与 /imagine-video 的指令构造 ──────────────────────────
 * 复刻自 xai-grok-tools-api slash_commands.rs 的 imagine_instruction /
 * imagine_usage_message / imagine_video_instruction /
 * imagine_video_usage_message（xai-grok-pager 的 /imagine、/imagine-video
 * 用它们展开成 InjectSkill 的 prompt_blocks）；agent 侧改名需同步。
 *
 * TUI 语义（imagine.rs / imagine_video.rs）：界面显示用户敲的
 * `/imagine <描述>`，发给模型的是下面这些指令块文本（display_text 与
 * prompt_blocks 分离）。shell 把 imagine / imagine-video 烧成
 * PAGER_COMMAND_KEYS 保留名（xai-grok-shell slash_commands.rs:487-597），
 * agent 不广播、同名 skill 也占用不了——FE 只能在本地实现这两条命令。
 */

/** 图片生成工具名（xai-grok-tools-api 的 IMAGE_GEN_TOOL_NAME）。 */
export const IMAGE_GEN_TOOL_NAME = 'image_gen'

/** 图生视频工具名（xai-grok-tools-api 的 IMAGE_TO_VIDEO_TOOL_NAME）。 */
export const IMAGE_TO_VIDEO_TOOL_NAME = 'image_to_video'

/** /imagine 无参数时的用法提示（TUI CommandResult::Message 原文）。 */
export function imagineUsageMessage(): string {
  return 'Usage: /imagine <description>\nProvide a text description to generate an image.'
}

/** /imagine <prompt> 展开给模型的指令块文本。 */
export function imagineInstruction(prompt: string): string {
  return (
    "Call the image_gen tool immediately, passing the user's prompt below " +
    'verbatim — do not rewrite, embellish, or expand it. ' +
    'After the tool completes, briefly acknowledge and mention ' +
    'where the image was saved.\n\n' +
    `Prompt: ${prompt}`
  )
}

/** /imagine-video 无参数时的用法提示（TUI 原文）。 */
export function imagineVideoUsageMessage(): string {
  return 'Usage: /imagine-video <description>\nProvide a text description to generate a video.'
}

/**
 * /imagine-video <prompt> 展开的指令块文本：视频工作流要点
 * （xai-grok-tools-api 的 IMAGINE_VIDEO_SKILL 语义，逐条对齐：
 * 源图起步、image_to_video 默认 / reference_to_video 按需、aspect_ratio
 * 设在源图上、6s/10s 时长、产物路径回呈现）。
 */
export function imagineVideoInstruction(prompt: string): string {
  return `${IMAGINE_VIDEO_SKILL}\n\nUser prompt: ${prompt}`
}

const IMAGINE_VIDEO_SKILL = `# Imagine Video

Video starts from an image — there is no text-to-video tool. \
Default to \`image_to_video\`; use \`reference_to_video\` when the user \
explicitly asks for it, a shot genuinely needs multiple reference images, \
or the subject should speak in a specific preset voice (\`voices\`).

If a video tool fails with a zero-data-retention (ZDR) storage error, relay \
that error verbatim and stop the workflow — do not generate more source \
images or retry.

## Default: single clip

Unless the user asks for a long video, multiple scenes, or a multi-shot \
sequence, generate **one** video:

1. Create a source image with \`image_gen\` that stages the first frame \
(composition, subject, lighting).
2. Call \`image_to_video\` with that image and a short prompt describing the \
motion or camera move (1–2 sentences, present tense).
3. After the tool completes, mention the saved file path so the user can find it.

## Longer / multi-shot videos

When the user requests a longer video, multiple scenes, or a narrative \
sequence:

1. **Plan the story as shots** — break the idea into distinct shots, one beat each.
2. **Favor frequent, short shots** — prefer more 6s clips over fewer long ones.
3. **Create each shot's source image** with \`image_gen\` (or \`image_edit\` to \
combine references), keeping characters and settings consistent across shots.
4. **Animate each shot with \`image_to_video\`** — the source image becomes frame 1.
5. **Assemble with FFmpeg** using stream copy (\`ffmpeg -f concat ... -c copy\`, \
never re-encode). Keep every shot at the same resolution and frame rate so \
the concat works. After assembly, mention the final output path.

## Shot guidance

- **Prompt-craft:** one short, vivid moment in present tense with a clear \
camera movement, in 1–2 sentences.
- **Minimal but interesting:** one clear subject, one simple motion or camera \
move per shot.
- **Complex source image?** Intricate frames warp when animated — keep the \
subject fixed and move only the camera (slow push-in, orbit, parallax), or \
break into simpler shots and generate a simpler, animation-friendly base image.
- **Aspect ratio:** set it on the source image (\`image_gen\` \`aspect_ratio\`); \
don't re-crop an existing video.
- **Duration:** 6s or 10s only (prefer 6s); round to the nearest. \
\`reference_to_video\` accepts 1–15s.
- **Speaking subjects:** to give a subject a voice, use \`reference_to_video\` \
with \`voices\` (up to 3 preset voice identifiers, e.g. "ara", "eve") and tag \
them in the prompt as \`<AUDIO_0>\`…; combine with reference \`images\` tagged \
\`<IMAGE_0>\`… for a consistent character.
- **Real people:** reference-first — drive the video from a verified reference \
image; never animate a named person without one.
- Don't loop the same clip unless asked.`
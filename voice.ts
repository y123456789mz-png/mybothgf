import {
  joinVoiceChannel,
  EndBehaviorType,
  createAudioPlayer,
  createAudioResource,
  StreamType,
  VoiceConnectionStatus,
  entersState,
  AudioPlayerStatus,
  type VoiceConnection,
  type AudioPlayer,
} from "@discordjs/voice";
import {
  ChannelType,
  type GuildMember,
  type VoiceBasedChannel,
} from "discord.js";
import prism from "prism-media";
import { spawn } from "node:child_process";
import { Readable, PassThrough } from "node:stream";
import { logger } from "./logger";
import { voiceChat } from "./ai";

type Session = {
  connection: VoiceConnection;
  player: AudioPlayer;
  channelId: string;
  guildId: string;
  speaking: Set<string>;
  busy: boolean;
};

const sessions = new Map<string, Session>();

export function getSession(guildId: string): Session | undefined {
  return sessions.get(guildId);
}

function bufferStream(stream: Readable): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (c: Buffer) => chunks.push(c));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

function pcm48kStereoToWav16kMono(pcm: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const ff = spawn(
      "ffmpeg",
      [
        "-loglevel",
        "error",
        "-f",
        "s16le",
        "-ar",
        "48000",
        "-ac",
        "2",
        "-i",
        "pipe:0",
        "-ar",
        "16000",
        "-ac",
        "1",
        "-f",
        "wav",
        "pipe:1",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const out: Buffer[] = [];
    const errOut: Buffer[] = [];
    ff.stdout.on("data", (c: Buffer) => out.push(c));
    ff.stderr.on("data", (c: Buffer) => errOut.push(c));
    ff.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`ffmpeg failed: ${Buffer.concat(errOut).toString()}`));
    });
    ff.stdin.write(pcm);
    ff.stdin.end();
  });
}

function wavToPcm48kStereo(wav: Buffer): Readable {
  const ff = spawn(
    "ffmpeg",
    [
      "-loglevel",
      "error",
      "-i",
      "pipe:0",
      "-f",
      "s16le",
      "-ar",
      "48000",
      "-ac",
      "2",
      "pipe:1",
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  ff.stdin.write(wav);
  ff.stdin.end();
  ff.stderr.on("data", () => {});
  const pass = new PassThrough();
  ff.stdout.pipe(pass);
  return pass;
}

async function handleSpeaker(
  session: Session,
  userId: string,
  displayName: string,
): Promise<void> {
  if (session.speaking.has(userId)) return;
  session.speaking.add(userId);

  try {
    const receiver = session.connection.receiver;
    const opusStream = receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: 1000 },
    });

    const decoder = new prism.opus.Decoder({
      frameSize: 960,
      channels: 2,
      rate: 48000,
    });

    const pcm = await bufferStream(opusStream.pipe(decoder) as unknown as Readable);

    if (pcm.length < 48000 * 2 * 2 * 0.4) {
      // Less than ~0.4s of audio — ignore.
      return;
    }

    if (session.busy) {
      logger.debug("Skipping speaker — bot is busy speaking");
      return;
    }
    session.busy = true;

    try {
      const wavIn = await pcm48kStereoToWav16kMono(pcm);
      logger.info(
        { userId, displayName, bytes: wavIn.length },
        "Sending voice clip to AI",
      );

      const result = await voiceChat(wavIn, displayName);

      if (result.transcript) {
        logger.info({ userId, transcript: result.transcript }, "User said");
      }
      if (result.replyText) {
        logger.info({ replyText: result.replyText }, "AI reply text");
      }

      if (!result.audioWav || result.audioWav.length === 0) {
        logger.warn("AI returned no audio");
        return;
      }

      const pcmStream = wavToPcm48kStereo(result.audioWav);
      const resource = createAudioResource(pcmStream, {
        inputType: StreamType.Raw,
      });
      session.player.play(resource);

      await new Promise<void>((resolve) => {
        const onIdle = () => {
          session.player.off(AudioPlayerStatus.Idle, onIdle);
          resolve();
        };
        session.player.on(AudioPlayerStatus.Idle, onIdle);
      });
    } finally {
      session.busy = false;
    }
  } catch (err) {
    logger.error({ err, userId }, "Voice handling failed");
  } finally {
    session.speaking.delete(userId);
  }
}

export async function joinChannel(
  member: GuildMember,
  channel: VoiceBasedChannel,
): Promise<Session> {
  const existing = sessions.get(channel.guild.id);
  if (existing) {
    existing.connection.destroy();
    sessions.delete(channel.guild.id);
  }

  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false,
    debug: true,
  });

  connection.on("debug", (msg) => {
    logger.info({ msg }, "[voice debug]");
  });

  logger.info({ channel: channel.name, guild: channel.guild.name }, "Connecting to voice...");

  connection.on("stateChange", (oldState, newState) => {
    logger.info(
      {
        from: oldState.status,
        to: newState.status,
        reason: (newState as { reason?: string }).reason,
        closeCode: (newState as { closeCode?: number }).closeCode,
      },
      "Voice connection state change",
    );
  });

  connection.on("error", (err) => {
    logger.error({ err }, "Voice connection error");
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
    logger.info({ channel: channel.name }, "Voice connection ready");
  } catch (err) {
    logger.error(
      { err, finalState: connection.state.status },
      "Voice connection never reached Ready",
    );
    try { connection.destroy(); } catch {}
    throw err;
  }

  const player = createAudioPlayer();
  player.on("error", (err) => {
    logger.error({ err }, "Audio player error");
  });
  connection.subscribe(player);

  const session: Session = {
    connection,
    player,
    channelId: channel.id,
    guildId: channel.guild.id,
    speaking: new Set(),
    busy: false,
  };
  sessions.set(channel.guild.id, session);

  connection.receiver.speaking.on("start", (userId) => {
    if (userId === member.client.user?.id) return;
    const guildMember = channel.guild.members.cache.get(userId);
    const name = guildMember?.displayName ?? "Someone";
    logger.info({ userId, name }, "User started speaking");
    void handleSpeaker(session, userId, name);
  });

  connection.receiver.speaking.on("end", (userId) => {
    if (userId === member.client.user?.id) return;
    logger.debug({ userId }, "User stopped speaking");
  });

  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
    } catch {
      connection.destroy();
      sessions.delete(channel.guild.id);
    }
  });

  return session;
}

export function leaveChannel(guildId: string): boolean {
  const session = sessions.get(guildId);
  if (!session) return false;
  try {
    session.player.stop(true);
  } catch {}
  try {
    session.connection.destroy();
  } catch {}
  sessions.delete(guildId);
  return true;
}

export function isVoiceChannel(
  channel: VoiceBasedChannel | null,
): channel is VoiceBasedChannel {
  return (
    !!channel &&
    (channel.type === ChannelType.GuildVoice ||
      channel.type === ChannelType.GuildStageVoice)
  );
}

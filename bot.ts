import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  ChannelType,
  type Message,
  type OmitPartialGroupDMChannel,
} from "discord.js";
import { chat, type ChatMessage } from "./ai";
import { logger } from "./logger";
import { joinChannel, leaveChannel, isVoiceChannel } from "./voice";
import { handleSlashCommand, registerCommandsForGuilds } from "./commands";

const HISTORY_LIMIT = 12;

const histories = new Map<string, ChatMessage[]>();

function getHistory(channelId: string): ChatMessage[] {
  let history = histories.get(channelId);
  if (!history) {
    history = [];
    histories.set(channelId, history);
  }
  return history;
}

function pushHistory(channelId: string, message: ChatMessage): void {
  const history = getHistory(channelId);
  history.push(message);
  if (history.length > HISTORY_LIMIT) {
    history.splice(0, history.length - HISTORY_LIMIT);
  }
}

function stripMention(content: string, botId: string): string {
  return content.replace(new RegExp(`<@!?${botId}>`, "g"), "").trim();
}

async function sendLongMessage(
  message: OmitPartialGroupDMChannel<Message<boolean>>,
  text: string,
): Promise<void> {
  const MAX = 2000;
  if (text.length <= MAX) {
    await message.reply(text);
    return;
  }

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > MAX) {
    let cut = remaining.lastIndexOf("\n", MAX);
    if (cut < MAX / 2) cut = MAX;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  if (remaining.length > 0) chunks.push(remaining);

  for (const [i, chunk] of chunks.entries()) {
    if (i === 0) {
      await message.reply(chunk);
    } else {
      await message.channel.send(chunk);
    }
  }
}

async function handleVoiceCommand(
  message: OmitPartialGroupDMChannel<Message<boolean>>,
  command: string,
): Promise<boolean> {
  const lower = command.toLowerCase().trim();

  if (lower === "join" || lower === "voice" || lower === "come") {
    if (!message.guild || !message.member) {
      await message.reply("I can only join voice channels in a server.");
      return true;
    }
    const voiceChannel = message.member.voice.channel;
    if (!isVoiceChannel(voiceChannel)) {
      await message.reply("Hop into a voice channel first, then ask me to join.");
      return true;
    }
    try {
      await joinChannel(message.member, voiceChannel);
      await message.reply(`Joined **${voiceChannel.name}**. Talk to me!`);
    } catch (err) {
      logger.error({ err }, "Failed to join voice");
      await message.reply(
        "Couldn't join the voice channel. Make sure I have the **Connect** and **Speak** permissions.",
      );
    }
    return true;
  }

  if (lower === "leave" || lower === "disconnect" || lower === "bye") {
    if (!message.guild) return false;
    const left = leaveChannel(message.guild.id);
    await message.reply(left ? "Left the voice channel." : "I'm not in a voice channel.");
    return true;
  }

  return false;
}

export function createBot(token: string): Client {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.GuildVoiceStates,
    ],
    partials: [Partials.Channel, Partials.Message],
  });

  client.once(Events.ClientReady, async (readyClient) => {
    logger.info(
      { user: readyClient.user.tag, id: readyClient.user.id },
      "Discord bot ready",
    );
    await registerCommandsForGuilds(readyClient, token);
  });

  client.on(Events.GuildCreate, async (guild) => {
    logger.info({ guild: guild.name }, "Joined new guild — registering commands");
    await registerCommandsForGuilds(client, token);
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    try {
      await handleSlashCommand(interaction);
    } catch (err) {
      logger.error({ err }, "Slash command failed");
      try {
        if (interaction.replied || interaction.deferred) {
          await interaction.editReply("Something went wrong.");
        } else {
          await interaction.reply({ content: "Something went wrong.", ephemeral: true });
        }
      } catch {
        // ignore
      }
    }
  });

  client.on(Events.MessageCreate, async (message) => {
    try {
      if (message.author.bot) return;
      if (!client.user) return;

      const isDM = message.channel.type === ChannelType.DM;
      const mentionsBot = message.mentions.users.has(client.user.id);

      if (!isDM && !mentionsBot) return;

      const userText = stripMention(message.content, client.user.id);
      if (!userText) {
        await message.reply("Hey! Ask me anything, or say `join` and I'll hop in your voice channel.");
        return;
      }

      const handled = await handleVoiceCommand(message, userText);
      if (handled) return;

      const channelId = message.channelId;
      pushHistory(channelId, { role: "user", content: userText });

      let typingInterval: NodeJS.Timeout | undefined;
      try {
        if ("sendTyping" in message.channel) {
          await message.channel.sendTyping();
          typingInterval = setInterval(() => {
            if ("sendTyping" in message.channel) {
              message.channel.sendTyping().catch(() => {});
            }
          }, 8000);
        }

        const reply = await chat(getHistory(channelId));
        pushHistory(channelId, { role: "assistant", content: reply });

        await sendLongMessage(message, reply);
      } finally {
        if (typingInterval) clearInterval(typingInterval);
      }
    } catch (err) {
      logger.error({ err }, "Failed to handle message");
      try {
        await message.reply(
          "Sorry, something went wrong while generating a reply.",
        );
      } catch {
        // ignore
      }
    }
  });

  client.on(Events.Error, (err) => {
    logger.error({ err }, "Discord client error");
  });

  void client.login(token);

  return client;
}

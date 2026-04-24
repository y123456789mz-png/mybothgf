import {
  REST,
  Routes,
  SlashCommandBuilder,
  type Client,
  type ChatInputCommandInteraction,
  ChannelType,
} from "discord.js";
import { logger } from "./logger";
import { chat, type ChatMessage } from "./ai";
import { joinChannel, leaveChannel, isVoiceChannel } from "./voice";

export const commands = [
  new SlashCommandBuilder()
    .setName("join")
    .setDescription("Make the bot join your voice channel"),
  new SlashCommandBuilder()
    .setName("leave")
    .setDescription("Make the bot leave the voice channel"),
  new SlashCommandBuilder()
    .setName("ask")
    .setDescription("Ask the AI a question")
    .addStringOption((opt) =>
      opt.setName("question").setDescription("What you want to ask").setRequired(true),
    ),
].map((c) => c.toJSON());

export async function registerCommandsForGuilds(
  client: Client,
  token: string,
): Promise<void> {
  if (!client.user) return;
  const rest = new REST({ version: "10" }).setToken(token);
  const guilds = [...client.guilds.cache.values()];

  for (const guild of guilds) {
    try {
      await rest.put(
        Routes.applicationGuildCommands(client.user.id, guild.id),
        { body: commands },
      );
      logger.info({ guild: guild.name }, "Registered slash commands");
    } catch (err) {
      logger.error({ err, guild: guild.name }, "Failed to register commands");
    }
  }
}

const askHistories = new Map<string, ChatMessage[]>();

function getHistory(channelId: string): ChatMessage[] {
  let h = askHistories.get(channelId);
  if (!h) {
    h = [];
    askHistories.set(channelId, h);
  }
  return h;
}

function pushHistory(channelId: string, msg: ChatMessage): void {
  const h = getHistory(channelId);
  h.push(msg);
  if (h.length > 12) h.splice(0, h.length - 12);
}

export async function handleSlashCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const name = interaction.commandName;

  if (name === "join") {
    if (!interaction.guild || !interaction.member) {
      await interaction.reply({
        content: "I can only join voice channels in a server.",
        ephemeral: true,
      });
      return;
    }
    const member = await interaction.guild.members.fetch(interaction.user.id);
    const voiceChannel = member.voice.channel;
    if (!isVoiceChannel(voiceChannel)) {
      await interaction.reply({
        content: "Hop into a voice channel first, then run `/join`.",
        ephemeral: true,
      });
      return;
    }
    await interaction.deferReply();
    try {
      await joinChannel(member, voiceChannel);
      await interaction.editReply(`Joined **${voiceChannel.name}**. Talk to me!`);
    } catch (err) {
      logger.error({ err }, "Failed to join voice");
      await interaction.editReply(
        "Couldn't join the voice channel. Make sure I have **Connect** and **Speak** permissions.",
      );
    }
    return;
  }

  if (name === "leave") {
    if (!interaction.guild) {
      await interaction.reply({ content: "Server only.", ephemeral: true });
      return;
    }
    const left = leaveChannel(interaction.guild.id);
    await interaction.reply(left ? "Left the voice channel." : "I'm not in a voice channel.");
    return;
  }

  if (name === "ask") {
    const question = interaction.options.getString("question", true);
    await interaction.deferReply();
    try {
      const channelId = interaction.channelId;
      pushHistory(channelId, { role: "user", content: question });
      const reply = await chat(getHistory(channelId));
      pushHistory(channelId, { role: "assistant", content: reply });

      const trimmed = reply.length > 1900 ? reply.slice(0, 1900) + "…" : reply;
      await interaction.editReply(trimmed);
    } catch (err) {
      logger.error({ err }, "Failed to handle /ask");
      await interaction.editReply("Sorry, something went wrong while generating a reply.");
    }
    return;
  }

  // Unknown command — guard the channel type warning so we don't crash.
  if (interaction.channel?.type === ChannelType.GuildText) {
    await interaction.reply({ content: "Unknown command.", ephemeral: true });
  }
}

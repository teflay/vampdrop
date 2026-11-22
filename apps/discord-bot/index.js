// discord-bot/index.js
import 'dotenv/config';
import { Client, GatewayIntentBits, SlashCommandBuilder, Routes, REST, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const GHOSTDROP_URL = process.env.GHOSTDROP_URL;
const GHOSTDROP_TOKEN = process.env.GHOSTDROP_TOKEN;

// Helper para hacer peticiones al backend
async function api(path, options = {}) {
  const res = await fetch(`${GHOSTDROP_URL}${path}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${GHOSTDROP_TOKEN}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || 'Error en la API');
  }
  return res.json();
}

// Formatear bytes
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024, sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

client.once('ready', () => {
  console.log(`Bot listo como ${client.user.tag}`);
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    if (interaction.commandName === 'stats') {
      await interaction.deferReply();
      const stats = await api('/api/bot/stats');
      
      const embed = new EmbedBuilder()
        .setTitle('📊 Estadísticas de Ghostdrop')
        .setColor(0x00AE86)
        .addFields(
          { name: 'Archivos Totales', value: `${stats.count}`, inline: true },
          { name: 'Espacio Usado', value: formatBytes(stats.storedBytes), inline: true },
          { name: 'Subidas Parciales', value: formatBytes(stats.partialBytes), inline: true },
          { name: 'Referencias Externas', value: `${stats.externalCount} (${formatBytes(stats.externalBytes)})`, inline: true }
        )
        .setTimestamp();
      
      await interaction.editReply({ embeds: [embed] });
    }

    if (interaction.commandName === 'files') {
      await interaction.deferReply();
      const search = interaction.options.getString('buscar') || '';
      const data = await api(`/api/bot/files?search=${encodeURIComponent(search)}&limit=5`);
      
      if (data.items.length === 0) {
        return interaction.editReply('No se encontraron archivos.');
      }

      const embed = new EmbedBuilder()
        .setTitle(search ? `🔍 Resultados para: ${search}` : '📁 Últimos archivos')
        .setColor(0x3498DB);

      for (const file of data.items) {
        const expiry = file.expiresAt < Date.now() ? '🔴 Expirado' : `🟢 Expira <t:${Math.floor(file.expiresAt / 1000)}:R>`;
        embed.addFields({
          name: file.name.length > 50 ? file.name.slice(0, 50) + '...' : file.name,
          value: `ID: \`${file.id}\`\nTamaño: ${formatBytes(file.size)}\n${expiry}`,
          inline: false
        });
      }

      // Botones de borrar (solo para el primer archivo, para no saturar)
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`delete_${data.items[0].id}`)
          .setLabel(`Borrar primer archivo`)
          .setStyle(ButtonStyle.Danger)
      );

      await interaction.editReply({ embeds: [embed], components: [row] });
    }

    if (interaction.commandName === 'cleanup') {
      await interaction.deferReply();
      const result = await api('/api/bot/cleanup', { method: 'POST' });
      await interaction.editReply(`🧹 Limpieza completada. Archivos eliminados: **${result.files}** | Parciales: **${result.partials}**`);
    }

  } catch (error) {
    console.error(error);
    const msg = `❌ Error: ${error.message}`;
    if (interaction.deferred) await interaction.editReply(msg);
    else await interaction.reply({ content: msg, ephemeral: true });
  }
});

// Manejar botones de borrar
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;
  if (interaction.customId.startsWith('delete_')) {
    const id = interaction.customId.split('_')[1];
    try {
      await api(`/api/bot/files/${id}`, { method: 'DELETE' });
      await interaction.reply({ content: '✅ Archivo borrado exitosamente.', ephemeral: true });
      // Opcional: Deshabilitar el botón original
      await interaction.message.edit({ components: [] });
    } catch (error) {
      await interaction.reply({ content: `❌ Error al borrar: ${error.message}`, ephemeral: true });
    }
  }
});

// Registrar comandos (solo la primera vez, o cada vez que inicies)
const commands = [
  new SlashCommandBuilder().setName('stats').setDescription('Muestra estadísticas de Ghostdrop'),
  new SlashCommandBuilder().setName('files')
    .setDescription('Lista los últimos archivos subidos')
    .addStringOption(option => option.setName('buscar').setDescription('Término de búsqueda').setRequired(false)),
  new SlashCommandBuilder().setName('cleanup').setDescription('Fuerza la limpieza de archivos expirados'),
].map(c => c.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log('Registrando comandos...');
    await rest.put(Routes.applicationCommands(process.env.DISCORD_CLIENT_ID), { body: commands });
    console.log('Comandos registrados con éxito.');
    client.login(process.env.DISCORD_TOKEN);
  } catch (error) {
    console.error(error);
  }
})();
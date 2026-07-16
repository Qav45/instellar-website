package gg.instellar.sync;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.bukkit.BanList;
import org.bukkit.Bukkit;
import org.bukkit.ChatColor;
import org.bukkit.configuration.ConfigurationSection;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;
import org.bukkit.event.player.AsyncPlayerChatEvent;
import org.bukkit.plugin.java.JavaPlugin;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.time.Instant;
import java.util.Date;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * InstellarSync — polls the Supabase 'mod_actions' table for actions queued
 * from the Instellar web moderation panel ('Pending' status), executes them
 * on this server (ban / kick / mute / warn / unban), then reports back
 * 'Executed' or 'Failed' so the panel updates live.
 */
public final class InstellarSyncPlugin extends JavaPlugin implements Listener {

    private static final Gson GSON = new Gson();

    private String baseUrl;
    private String serviceKey;
    /** Which panel server this Minecraft server is: "instellar1" or "instellar2". */
    private String serverId;
    private HttpClient http;
    /** lowercase player name -> mute expiry (epoch ms; 0 = permanent) */
    private final Map<String, Long> mutes = new ConcurrentHashMap<>();

    @Override
    public void onEnable() {
        saveDefaultConfig();
        baseUrl = getConfig().getString("supabase-url", "").replaceAll("/+$", "");
        serviceKey = getConfig().getString("service-role-key", "");
        serverId = getConfig().getString("server", "instellar1").trim().toLowerCase();
        if (baseUrl.isEmpty() || serviceKey.isEmpty() || serviceKey.contains("PASTE")) {
            getLogger().severe("Set supabase-url and service-role-key in plugins/InstellarSync/config.yml, then restart.");
            getServer().getPluginManager().disablePlugin(this);
            return;
        }
        http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();
        loadMutes();
        getServer().getPluginManager().registerEvents(this, this);
        long ticks = 20L * Math.max(2, getConfig().getInt("poll-seconds", 5));
        getServer().getScheduler().runTaskTimerAsynchronously(this, this::poll, 40L, ticks);
        getLogger().info("InstellarSync connected to " + baseUrl + " as " + serverId);
    }

    // ---------------------------------------------------------------- polling

    private void poll() {
        try {
            HttpRequest req = HttpRequest.newBuilder(URI.create(baseUrl
                            + "/rest/v1/mod_actions?status=eq.Pending&server=eq." + serverId
                            + "&order=created_at.asc&limit=20&select=*"))
                    .header("apikey", serviceKey)
                    .header("Authorization", "Bearer " + serviceKey)
                    .timeout(Duration.ofSeconds(10))
                    .GET().build();
            HttpResponse<String> res = http.send(req, HttpResponse.BodyHandlers.ofString());
            if (res.statusCode() != 200) {
                getLogger().warning("Supabase poll failed: HTTP " + res.statusCode());
                return;
            }
            JsonArray arr = JsonParser.parseString(res.body()).getAsJsonArray();
            for (JsonElement el : arr) {
                JsonObject a = el.getAsJsonObject();
                long id = a.get("id").getAsLong();
                String type = a.get("type").getAsString();
                String target = a.get("target").getAsString();
                String reason = a.get("reason").getAsString();
                String by = a.get("by_name").getAsString();
                String duration = (a.get("duration") == null || a.get("duration").isJsonNull())
                        ? null : a.get("duration").getAsString();
                // Execute on the main thread; report back async.
                getServer().getScheduler().runTask(this, () -> {
                    String error = execute(type, target, reason, by, duration);
                    getServer().getScheduler().runTaskAsynchronously(this, () -> report(id, error));
                });
            }
        } catch (Exception e) {
            getLogger().warning("Supabase poll error: " + e.getMessage());
        }
    }

    /** Runs on the main thread. Returns null on success, or an error message. */
    @SuppressWarnings("deprecation")
    private String execute(String type, String target, String reason, String by, String duration) {
        Player p = Bukkit.getPlayerExact(target);
        switch (type) {
            case "Ban": {
                Date expires = expiry(duration);
                Bukkit.getBanList(BanList.Type.NAME).addBan(target, reason, expires, by);
                if (p != null) p.kickPlayer(ChatColor.RED + "You are banned from this server.\n"
                        + ChatColor.GRAY + "Reason: " + ChatColor.WHITE + reason);
                broadcastStaff(target + " was banned by " + by + " (" + (duration == null ? "Permanent" : duration) + ")");
                return null;
            }
            case "Kick": {
                if (p == null) return "Player is not online";
                p.kickPlayer(ChatColor.RED + "You were kicked.\n"
                        + ChatColor.GRAY + "Reason: " + ChatColor.WHITE + reason);
                broadcastStaff(target + " was kicked by " + by);
                return null;
            }
            case "Mute": {
                mutes.put(target.toLowerCase(), expiryMillis(duration));
                saveMutes();
                if (p != null) p.sendMessage(ChatColor.RED + "You have been muted"
                        + (duration != null && !duration.equals("Permanent") ? " for " + duration : "")
                        + ". " + ChatColor.GRAY + "Reason: " + reason);
                return null;
            }
            case "Warn": {
                if (p != null) p.sendMessage(ChatColor.GOLD + "⚠ Warning from staff: " + ChatColor.WHITE + reason);
                return null; // warnings are recorded even if the player is offline
            }
            case "Unban": {
                Bukkit.getBanList(BanList.Type.NAME).pardon(target);
                mutes.remove(target.toLowerCase());
                saveMutes();
                broadcastStaff(target + " was unbanned by " + by);
                return null;
            }
            default:
                return "Unknown action type: " + type;
        }
    }

    private void broadcastStaff(String msg) {
        for (Player pl : Bukkit.getOnlinePlayers()) {
            if (pl.hasPermission("instellar.staff")) {
                pl.sendMessage(ChatColor.DARK_GRAY + "[" + ChatColor.LIGHT_PURPLE + "Panel" + ChatColor.DARK_GRAY + "] "
                        + ChatColor.GRAY + msg);
            }
        }
        getLogger().info(msg);
    }

    private Date expiry(String duration) {
        long ms = expiryMillis(duration);
        return ms == 0 ? null : new Date(ms);
    }

    /** 0 = permanent; otherwise epoch ms when the punishment ends. */
    private long expiryMillis(String duration) {
        if (duration == null || duration.equals("Permanent")) return 0;
        long now = System.currentTimeMillis();
        switch (duration) {
            case "1 hour":  return now + 3_600_000L;
            case "1 day":   return now + 86_400_000L;
            case "7 days":  return now + 7L * 86_400_000L;
            case "30 days": return now + 30L * 86_400_000L;
            default:        return 0;
        }
    }

    // ---------------------------------------------------------------- report

    private void report(long id, String error) {
        try {
            String body = error == null
                    ? "{\"status\":\"Executed\",\"executed_at\":" + GSON.toJson(Instant.now().toString()) + "}"
                    : "{\"status\":\"Failed\",\"error\":" + GSON.toJson(error) + "}";
            HttpRequest req = HttpRequest.newBuilder(URI.create(baseUrl + "/rest/v1/mod_actions?id=eq." + id))
                    .header("apikey", serviceKey)
                    .header("Authorization", "Bearer " + serviceKey)
                    .header("Content-Type", "application/json")
                    .header("Prefer", "return=minimal")
                    .timeout(Duration.ofSeconds(10))
                    .method("PATCH", HttpRequest.BodyPublishers.ofString(body))
                    .build();
            HttpResponse<String> res = http.send(req, HttpResponse.BodyHandlers.ofString());
            if (res.statusCode() >= 300) {
                getLogger().warning("Could not report action " + id + ": HTTP " + res.statusCode());
            }
        } catch (Exception e) {
            getLogger().warning("Could not report action " + id + ": " + e.getMessage());
        }
    }

    // ---------------------------------------------------------------- mutes

    @EventHandler
    public void onChat(AsyncPlayerChatEvent e) {
        Long until = mutes.get(e.getPlayer().getName().toLowerCase());
        if (until == null) return;
        if (until != 0 && until < System.currentTimeMillis()) {
            mutes.remove(e.getPlayer().getName().toLowerCase());
            getServer().getScheduler().runTask(this, this::saveMutes);
            return;
        }
        e.setCancelled(true);
        e.getPlayer().sendMessage(ChatColor.RED + "You are muted and cannot chat.");
    }

    private void loadMutes() {
        ConfigurationSection sec = getConfig().getConfigurationSection("mutes");
        if (sec == null) return;
        for (String key : sec.getKeys(false)) mutes.put(key.toLowerCase(), sec.getLong(key));
    }

    private void saveMutes() {
        getConfig().set("mutes", new HashMap<>(mutes));
        saveConfig();
    }
}

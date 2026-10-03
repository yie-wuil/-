package com.shiguangzhou.app;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 系统设置跳转插件
 * 目的：让「提醒健康检查」里的每一项都能一键直达对应系统页面。
 * 同时把两件在 JS 层做不到的事补上：
 *   1. 电池优化白名单的真实状态（PowerManager.isIgnoringBatteryOptimizations）
 *   2. 厂商自启动页的 Intent 链式跳转
 */
@CapacitorPlugin(name = "SystemSettings")
public class SystemSettingsPlugin extends Plugin {

    /* ---------------- 设备与状态探测 ---------------- */

    @PluginMethod
    public void getDeviceInfo(PluginCall call) {
        Context ctx = getContext();
        JSObject ret = new JSObject();
        String manu = Build.MANUFACTURER == null ? "" : Build.MANUFACTURER;
        String brand = Build.BRAND == null ? "" : Build.BRAND;
        ret.put("manufacturer", manu);
        ret.put("brand", brand);
        ret.put("model", Build.MODEL == null ? "" : Build.MODEL);
        ret.put("sdkInt", Build.VERSION.SDK_INT);
        ret.put("vendor", detectVendor(manu + " " + brand));
        ret.put("ignoringBatteryOptimizations", isIgnoringBatteryOptimizations(ctx));
        ret.put("canScheduleExactAlarms", canScheduleExactAlarms(ctx));
        call.resolve(ret);
    }

    private String detectVendor(String raw) {
        String m = raw.toLowerCase();
        if (m.contains("xiaomi") || m.contains("redmi") || m.contains("poco")) return "xiaomi";
        if (m.contains("huawei") || m.contains("honor")) return "huawei";
        if (m.contains("oppo") || m.contains("realme") || m.contains("oneplus") || m.contains("oplus")) return "oppo";
        if (m.contains("vivo") || m.contains("iqoo")) return "vivo";
        if (m.contains("samsung")) return "samsung";
        if (m.contains("meizu")) return "meizu";
        return "other";
    }

    private boolean isIgnoringBatteryOptimizations(Context ctx) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true;
        try {
            PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
            return pm != null && pm.isIgnoringBatteryOptimizations(ctx.getPackageName());
        } catch (Exception e) {
            return false;
        }
    }

    private boolean canScheduleExactAlarms(Context ctx) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true;
        try {
            android.app.AlarmManager am = (android.app.AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
            return am != null && am.canScheduleExactAlarms();
        } catch (Exception e) {
            return false;
        }
    }

    /* ---------------- 跳转：通用封装 ---------------- */

    private boolean startIntent(Intent intent) {
        try {
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    /** 按组件名尝试启动，不存在或不可导出则返回 false */
    private boolean tryComponent(String pkg, String cls) {
        try {
            Intent i = new Intent();
            i.setComponent(new ComponentName(pkg, cls));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            if (getContext().getPackageManager().resolveActivity(i, 0) == null) return false;
            i.putExtra("packageName", getContext().getPackageName());
            getContext().startActivity(i);
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    private boolean openAppDetails() {
        try {
            Intent i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
            i.setData(Uri.parse("package:" + getContext().getPackageName()));
            return startIntent(i);
        } catch (Exception e) {
            return false;
        }
    }

    /* ---------------- 跳转：通知渠道 ---------------- */

    @PluginMethod
    public void openChannelSettings(PluginCall call) {
        String chId = call.getString("channelId", "");
        Context ctx = getContext();
        boolean ok = false;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && chId != null && !chId.isEmpty()) {
            try {
                Intent i = new Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS);
                i.putExtra(Settings.EXTRA_APP_PACKAGE, ctx.getPackageName());
                i.putExtra(Settings.EXTRA_CHANNEL_ID, chId);
                ok = startIntent(i);
            } catch (Exception e) { ok = false; }
        }
        if (!ok) ok = openAppNotificationSettingsInternal();
        if (!ok) ok = openAppDetails();
        JSObject r = new JSObject();
        r.put("ok", ok);
        call.resolve(r);
    }

    @PluginMethod
    public void openAppNotificationSettings(PluginCall call) {
        boolean ok = openAppNotificationSettingsInternal();
        if (!ok) ok = openAppDetails();
        JSObject r = new JSObject();
        r.put("ok", ok);
        call.resolve(r);
    }

    private boolean openAppNotificationSettingsInternal() {
        Context ctx = getContext();
        try {
            Intent i;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                i = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS);
                i.putExtra(Settings.EXTRA_APP_PACKAGE, ctx.getPackageName());
            } else {
                i = new Intent("android.settings.APP_NOTIFICATION_SETTINGS");
                i.putExtra("app_package", ctx.getPackageName());
                i.putExtra("app_uid", ctx.getApplicationInfo().uid);
            }
            return startIntent(i);
        } catch (Exception e) { return false; }
    }

    /* ---------------- 跳转：电池优化 ---------------- */

    @PluginMethod
    public void openBatteryOptimization(PluginCall call) {
        Context ctx = getContext();
        JSObject r = new JSObject();
        if (isIgnoringBatteryOptimizations(ctx)) {
            r.put("ok", true);
            r.put("alreadyOk", true);
            call.resolve(r);
            return;
        }
        boolean ok = false;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            try {
                Intent i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
                i.setData(Uri.parse("package:" + ctx.getPackageName()));
                ok = startIntent(i);
            } catch (Exception e) { ok = false; }
        }
        if (!ok) {
            try {
                ok = startIntent(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
            } catch (Exception e) { ok = false; }
        }
        if (!ok) ok = openAppDetails();
        r.put("ok", ok);
        r.put("alreadyOk", false);
        call.resolve(r);
    }

    /* ---------------- 跳转：厂商自启动 ---------------- */

    @PluginMethod
    public void openAutoStart(PluginCall call) {
        String vendor = call.getString("vendor", null);
        if (vendor == null || vendor.isEmpty()) {
            vendor = detectVendor(Build.MANUFACTURER + " " + Build.BRAND);
        }
        boolean ok = false;
        String hit = "none";

        if ("xiaomi".equals(vendor)) {
            if (tryComponent("com.miui.securitycenter", "com.miui.permcenter.autostart.AutoStartManagementActivity")) { ok = true; hit = "miui-1"; }
        } else if ("huawei".equals(vendor)) {
            if (tryComponent("com.huawei.systemmanager", "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity")) { ok = true; hit = "emui-1"; }
            else if (tryComponent("com.huawei.systemmanager", "com.huawei.systemmanager.appcontrol.activity.StartupAppControlActivity")) { ok = true; hit = "emui-2"; }
        } else if ("oppo".equals(vendor)) {
            if (tryComponent("com.coloros.safecenter", "com.coloros.safecenter.permission.startup.StartupAppListActivity")) { ok = true; hit = "coloros-1"; }
            else if (tryComponent("com.coloros.safecenter", "com.coloros.safecenter.startupapp.StartupAppListActivity")) { ok = true; hit = "coloros-2"; }
            else if (tryComponent("com.oplus.safecenter", "com.oplus.safecenter.permission.startup.StartupAppListActivity")) { ok = true; hit = "coloros-3"; }
            else if (tryComponent("com.oneplus.security", "com.oneplus.security.chainlaunch.view.ChainLaunchAppListActivity")) { ok = true; hit = "oneplus"; }
        } else if ("vivo".equals(vendor)) {
            if (tryComponent("com.vivo.permissionmanager", "com.vivo.permissionmanager.activity.BgStartUpManagerActivity")) { ok = true; hit = "funtouch-1"; }
            else if (tryComponent("com.iqoo.secure", "com.iqoo.secure.ui.phoneoptimize.AddWhiteListActivity")) { ok = true; hit = "funtouch-2"; }
        } else if ("samsung".equals(vendor)) {
            if (tryComponent("com.samsung.android.lool", "com.samsung.android.sm.ui.battery.BatteryActivity")) { ok = true; hit = "oneui-1"; }
            else if (tryComponent("com.samsung.android.sm", "com.samsung.android.sm.ui.battery.BatteryActivity")) { ok = true; hit = "oneui-2"; }
        }

        // 全部失败  降级到应用详情页
        if (!ok) { ok = openAppDetails(); hit = "fallback-appdetails"; }

        JSObject r = new JSObject();
        r.put("ok", ok);
        r.put("vendor", vendor);
        r.put("hit", hit);
        call.resolve(r);
    }

    /* ---------------- 跳转：应用详情页 ---------------- */

    @PluginMethod
    public void openAppDetailsSettings(PluginCall call) {
        JSObject r = new JSObject();
        r.put("ok", openAppDetails());
        call.resolve(r);
    }
}
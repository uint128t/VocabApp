package com.uint128t.vocabapp;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.DocumentsContract;
import android.provider.MediaStore;
import android.provider.Settings;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 外部文件（D48）：这一组能力只有 Capacitor 的桥页能调（主界面所在 WebView 没有插件桥）。
 *   · isGranted / openSettings —— 「所有文件访问」（MANAGE_EXTERNAL_STORAGE）的查询与申请入口；
 *   · pickFile —— 系统文件选择器选一份文件，尽力把它还原成**真实路径**（外置存储提供者的
 *     documentId 是 `primary:rel/path` 这种形状，拼回 /storage/... 即可）；云盘之类拿不到
 *     真实路径的返回 uri 而不返回 path，由前端提示改用「从文件导入」。
 * 拿到真实路径后，读写在 Node 侧直接用 fs 完成（有「所有文件访问」就畅通）。
 */
@CapacitorPlugin(name = "StoragePermission")
public class StoragePermissionPlugin extends Plugin {

    @PluginMethod
    public void isGranted(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("granted", hasAllFilesAccess());
        call.resolve(ret);
    }

    @PluginMethod
    public void openSettings(PluginCall call) {
        try {
            Intent intent;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                intent = new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
                        Uri.parse("package:" + getContext().getPackageName()));
            } else {
                intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                        Uri.parse("package:" + getContext().getPackageName()));
            }
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            try {
                getContext().startActivity(intent);
            } catch (ActivityNotFoundException e) {
                // 个别 ROM 没有「本应用」的直达页：退到全局的访问列表
                Intent fallback = new Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION);
                fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(fallback);
            }
            call.resolve();
        } catch (Exception e) {
            call.reject("无法打开系统设置：" + e.getMessage());
        }
    }

    @PluginMethod
    public void pickFile(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("*/*");
        intent.putExtra(Intent.EXTRA_MIME_TYPES, new String[] {
                "text/markdown", "text/plain", "text/*", "application/octet-stream"
        });
        startActivityForResult(call, intent, "pickFileResult");
    }

    @ActivityCallback
    private void pickFileResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        JSObject ret = new JSObject();
        if (result.getResultCode() != android.app.Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) {
            call.resolve(ret); // 取消：什么都不给，前端当作没选
            return;
        }
        Uri uri = result.getData().getData();
        ret.put("uri", uri.toString());
        String path = resolveToRealPath(uri);
        ret.put("path", path);
        if (path == null) {
            // 诊断信息：真实机型上「解析不了」的原因各不相同，让前端能把它显示出来
            try {
                ret.put("authority", uri.getAuthority());
                ret.put("docId", DocumentsContract.getDocumentId(uri));
            } catch (Exception ignored) {
            }
        }
        call.resolve(ret);
    }

    /** 把 content:// 还原成 /storage/... 的真实路径；还原不了返回 null。 */
    private String resolveToRealPath(Uri uri) {
        try {
            String scheme = uri.getScheme();
            if (scheme == null) return null;
            if ("file".equals(scheme)) return uri.getPath();
            if (!"content".equals(scheme)) return null;
            String authority = uri.getAuthority();
            String docId = null;
            try {
                docId = DocumentsContract.getDocumentId(uri);
            } catch (Exception ignored) {
            }
            if ("com.android.externalstorage.documents".equals(authority) && docId != null) {
                int colon = docId.indexOf(':');
                if (colon > 0) {
                    String type = docId.substring(0, colon);
                    String rel = docId.substring(colon + 1);
                    if ("primary".equalsIgnoreCase(type)) return Environment.getExternalStorageDirectory() + "/" + rel;
                    return "/storage/" + type + "/" + rel;
                }
            }
            // 媒体库（相册/下载/文档都可能走这里）：docId 形如 `document:1000000028` 或纯数字，
            // 拿这个 _id 去 MediaStore 查真实路径
            if (authority != null && authority.startsWith("com.android.providers.media") && docId != null) {
                String numeric = docId.startsWith("document:") ? docId.substring("document:".length()) : docId;
                if (numeric.matches("\\d+")) {
                    String fromMedia = queryMediaStore(numeric);
                    if (fromMedia != null) return fromMedia;
                }
            }
            if ("com.android.providers.downloads.documents".equals(authority) && docId != null && docId.startsWith("raw:")) {
                return docId.substring(4);
            }
            // 兜底：部分 ROM 的下载 / 第三方提供者还能从 _data 列给出真实路径
            return queryDataColumn(uri);
        } catch (Exception ignored) {
            return null;
        }
    }

    private String queryMediaStore(String id) {
        Uri files = MediaStore.Files.getContentUri("external");
        try (Cursor c = getContext().getContentResolver().query(
                files,
                new String[] { MediaStore.MediaColumns.DATA },
                MediaStore.MediaColumns._ID + "=?",
                new String[] { id },
                null)) {
            if (c != null && c.moveToFirst()) {
                String path = c.getString(0);
                if (path != null && !path.isEmpty()) return path;
            }
        } catch (Exception ignored) {
        }
        return null;
    }

    private String queryDataColumn(Uri uri) {
        try (Cursor c = getContext().getContentResolver().query(uri, new String[] { "_data" }, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                int idx = c.getColumnIndex("_data");
                if (idx >= 0) {
                    String path = c.getString(idx);
                    if (path != null && !path.isEmpty()) return path;
                }
            }
        } catch (Exception ignored) {
        }
        return null;
    }

    private boolean hasAllFilesAccess() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            return Environment.isExternalStorageManager();
        }
        return getContext().checkSelfPermission(android.Manifest.permission.WRITE_EXTERNAL_STORAGE)
                == PackageManager.PERMISSION_GRANTED;
    }
}

package com.uint128t.vocabapp;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 自定义插件要赶在 super.onCreate 之前注册（Capacitor 的规矩）
        registerPlugin(StoragePermissionPlugin.class);
        super.onCreate(savedInstanceState);
    }
}

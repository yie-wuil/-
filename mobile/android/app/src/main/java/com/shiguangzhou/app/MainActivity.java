package com.shiguangzhou.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 必须在 super.onCreate 之前注册
        registerPlugin(SystemSettingsPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
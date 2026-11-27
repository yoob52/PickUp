package com.yoob52.pickup;

import android.os.Bundle;
import android.view.ViewGroup.MarginLayoutParams;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(PickupUpdater.class);
        super.onCreate(savedInstanceState);
        if (getBridge() == null) return;
        WebView webView = getBridge().getWebView();
        ViewCompat.setOnApplyWindowInsetsListener(webView, (view, windowInsets) -> {
            Insets insets = windowInsets.getInsets(
                WindowInsetsCompat.Type.systemBars() |
                WindowInsetsCompat.Type.displayCutout() |
                WindowInsetsCompat.Type.ime()
            );
            MarginLayoutParams margins = (MarginLayoutParams) view.getLayoutParams();
            margins.setMargins(insets.left, insets.top, insets.right, insets.bottom);
            view.setLayoutParams(margins);
            return WindowInsetsCompat.CONSUMED;
        });
        ViewCompat.requestApplyInsets(webView);
        WindowCompat.getInsetsController(getWindow(), webView).setAppearanceLightStatusBars(true);
        WindowCompat.getInsetsController(getWindow(), webView).setAppearanceLightNavigationBars(true);
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (webView.canGoBack()) {
                    webView.goBack();
                } else {
                    setEnabled(false);
                    getOnBackPressedDispatcher().onBackPressed();
                    setEnabled(true);
                }
            }
        });
    }
}

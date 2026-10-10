package ru.kinolike.tv.ui

import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.darkColorScheme

val KinoBackground = Color(0xFF080A0F)
val KinoSurface = Color(0xFF151A24)
val KinoGold = Color(0xFFE8C76A)
val KinoText = Color(0xFFF5F1E7)
val KinoMuted = Color(0xFFAAAEB9)

@Composable
fun KinoLikeTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = darkColorScheme(
            primary = KinoGold,
            onPrimary = Color(0xFF201A08),
            background = KinoBackground,
            onBackground = KinoText,
            surface = KinoSurface,
            onSurface = KinoText,
        ),
        content = content,
    )
}

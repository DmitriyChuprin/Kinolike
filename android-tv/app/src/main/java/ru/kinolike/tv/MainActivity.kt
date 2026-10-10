package ru.kinolike.tv

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import ru.kinolike.tv.data.KinoRepository
import ru.kinolike.tv.data.SessionStore
import ru.kinolike.tv.ui.KinoLikeApp
import ru.kinolike.tv.ui.KinoLikeTheme
import ru.kinolike.tv.ui.MainViewModel

class MainActivity : ComponentActivity() {
    private val viewModel: MainViewModel by viewModels {
        MainViewModel.Factory(KinoRepository(SessionStore(applicationContext)))
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent { KinoLikeTheme { KinoLikeApp(viewModel) } }
    }
}

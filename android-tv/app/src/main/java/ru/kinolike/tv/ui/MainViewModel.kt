package ru.kinolike.tv.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import ru.kinolike.tv.data.HomeContent
import ru.kinolike.tv.data.KinoRepository
import ru.kinolike.tv.data.MediaItem
import ru.kinolike.tv.data.User

sealed interface ScreenState {
    data object Starting : ScreenState
    data class Server(val value: String = "", val busy: Boolean = false, val error: String? = null) : ScreenState
    data class Login(val serverUrl: String, val busy: Boolean = false, val error: String? = null) : ScreenState
    data class Home(
        val user: User,
        val content: HomeContent? = null,
        val busy: Boolean = true,
        val error: String? = null,
    ) : ScreenState
    data class Details(
        val user: User,
        val initial: MediaItem,
        val item: MediaItem? = null,
        val busy: Boolean = true,
        val error: String? = null,
    ) : ScreenState
}

class MainViewModel(private val repository: KinoRepository) : ViewModel() {
    private val _state = MutableStateFlow<ScreenState>(ScreenState.Starting)
    val state: StateFlow<ScreenState> = _state.asStateFlow()
    private var currentUser: User? = null

    init { restoreSession() }

    private fun restoreSession() = viewModelScope.launch {
        val server = repository.savedServer()
        if (server == null) {
            _state.value = ScreenState.Server()
            return@launch
        }
        try {
            repository.configure(server)
            val user = repository.restoreUser()
            currentUser = user
            showHome(user)
        } catch (error: Throwable) {
            _state.value = if (error is retrofit2.HttpException && error.code() == 401) {
                ScreenState.Login(server)
            } else {
                ScreenState.Server(server, error = KinoRepository.readableError(error))
            }
        }
    }

    fun connect(value: String) = viewModelScope.launch {
        _state.value = ScreenState.Server(value, busy = true)
        try {
            val normalized = repository.connect(value)
            _state.value = ScreenState.Login(normalized)
        } catch (error: Throwable) {
            _state.value = ScreenState.Server(value, error = KinoRepository.readableError(error))
        }
    }

    fun login(serverUrl: String, email: String, password: String) = viewModelScope.launch {
        if (email.isBlank() || password.isBlank()) {
            _state.value = ScreenState.Login(serverUrl, error = "Введите email и пароль")
            return@launch
        }
        _state.value = ScreenState.Login(serverUrl, busy = true)
        try {
            val user = repository.login(email, password)
            currentUser = user
            showHome(user)
        } catch (error: Throwable) {
            _state.value = ScreenState.Login(serverUrl, error = KinoRepository.readableError(error))
        }
    }

    private fun showHome(user: User) {
        _state.value = ScreenState.Home(user, busy = true)
        viewModelScope.launch {
            try {
                _state.value = ScreenState.Home(user, content = repository.loadHome(), busy = false)
            } catch (error: Throwable) {
                _state.value = ScreenState.Home(user, busy = false, error = KinoRepository.readableError(error))
            }
        }
    }

    fun retryHome() { currentUser?.let(::showHome) }

    fun openDetails(item: MediaItem) {
        val user = currentUser ?: return
        _state.value = ScreenState.Details(user, initial = item)
        viewModelScope.launch {
            try {
                _state.value = ScreenState.Details(user, item, repository.details(item), busy = false)
            } catch (error: Throwable) {
                _state.value = ScreenState.Details(user, item, busy = false, error = KinoRepository.readableError(error))
            }
        }
    }

    fun backToHome() { currentUser?.let(::showHome) }

    fun changeServer() {
        viewModelScope.launch {
            repository.logout()
            currentUser = null
            _state.value = ScreenState.Server(repository.savedServer().orEmpty())
        }
    }

    fun imageUrl(path: String?, size: String = "w500") = repository.imageUrl(path, size)

    class Factory(private val repository: KinoRepository) : ViewModelProvider.Factory {
        @Suppress("UNCHECKED_CAST")
        override fun <T : ViewModel> create(modelClass: Class<T>): T = MainViewModel(repository) as T
    }
}

package ru.kinolike.tv.data

import com.google.gson.Gson
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.supervisorScope
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.HttpException
import retrofit2.Retrofit
import retrofit2.converter.gson.GsonConverterFactory
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.util.concurrent.TimeUnit

class KinoRepository(private val sessions: SessionStore) {
    private var configuredUrl: String? = null
    private var api: KinoApi? = null

    fun savedServer(): String? = sessions.serverUrl

    fun configure(rawUrl: String): String {
        val normalized = normalizeServerUrl(rawUrl)
        if (configuredUrl != normalized) {
            val client = OkHttpClient.Builder()
                .cookieJar(sessions.cookieJar)
                .connectTimeout(12, TimeUnit.SECONDS)
                .readTimeout(25, TimeUnit.SECONDS)
                .addInterceptor(HttpLoggingInterceptor().apply { level = HttpLoggingInterceptor.Level.BASIC })
                .build()
            api = Retrofit.Builder()
                .baseUrl(normalized)
                .client(client)
                .addConverterFactory(GsonConverterFactory.create())
                .build()
                .create(KinoApi::class.java)
            configuredUrl = normalized
        }
        return normalized
    }

    suspend fun connect(rawUrl: String): String {
        val normalized = configure(rawUrl)
        requireApi().popularMovies()
        sessions.serverUrl = normalized
        return normalized
    }

    suspend fun restoreUser(): User = requireApi().me().user

    suspend fun login(email: String, password: String): User =
        requireApi().login(AuthRequest(email.trim(), password)).user

    suspend fun logout() {
        runCatching { requireApi().logout() }
        sessions.cookieJar.clear()
    }

    suspend fun loadHome(): HomeContent = supervisorScope {
        val movieTrending = async { runCatching { requireApi().trendingMovies().results }.getOrDefault(emptyList()) }
        val popular = async { runCatching { requireApi().popularMovies().results }.getOrDefault(emptyList()) }
        val tv = async { runCatching { requireApi().trendingTv().results }.getOrDefault(emptyList()) }
        val rated = async { runCatching { requireApi().topRatedMovies().results }.getOrDefault(emptyList()) }
        val continuation = async { loadContinueWatching() }

        val rows = listOf(
            HomeRow("В тренде", movieTrending.await().map { it.copy(mediaType = "movie") }),
            HomeRow("Популярные фильмы", popular.await().map { it.copy(mediaType = "movie") }),
            HomeRow("Сериалы в тренде", tv.await().map { it.copy(mediaType = "tv") }),
            HomeRow("Высокий рейтинг", rated.await().map { it.copy(mediaType = "movie") }),
        ).filter { it.items.isNotEmpty() }
        if (rows.isEmpty()) error("Каталог не вернул ни одной подборки")
        HomeContent(continuation.await(), rows)
    }

    private suspend fun loadContinueWatching(): List<ContinueMedia> {
        val positions = runCatching { requireApi().continueWatching().items }.getOrDefault(emptyList())
        return supervisorScope {
            positions.map { progress ->
                async {
                    runCatching {
                        ContinueMedia(progress, requireApi().details(progress.mediaType, progress.tmdbId)
                            .copy(mediaType = progress.mediaType))
                    }.getOrNull()
                }
            }.awaitAll().filterNotNull()
        }
    }

    suspend fun details(item: MediaItem): MediaItem =
        requireApi().details(item.resolvedType(), item.id).copy(mediaType = item.resolvedType())

    fun imageUrl(path: String?, size: String = "w500"): String? {
        if (path.isNullOrBlank()) return null
        val base = configuredUrl ?: sessions.serverUrl ?: return null
        val encoded = URLEncoder.encode(path, StandardCharsets.UTF_8.name())
        return "${base}api/tmdb/image?path=$encoded&size=$size"
    }

    private fun requireApi(): KinoApi = api ?: error("Сервер KinoLike не настроен")

    companion object {
        fun normalizeServerUrl(raw: String): String {
            val value = raw.trim().trimEnd('/')
            require(value.isNotEmpty()) { "Введите адрес сервера" }
            val url = runCatching { "$value/".toHttpUrl() }
                .getOrElse { throw IllegalArgumentException("Некорректный адрес сервера") }
            require(url.scheme == "https") { "KinoLike TV подключается только по HTTPS" }
            require(url.username.isEmpty() && url.password.isEmpty()) { "Не указывайте логин и пароль в адресе" }
            require(url.query == null && url.fragment == null) { "Укажите базовый адрес без параметров" }
            return url.toString()
        }

        fun readableError(error: Throwable): String {
            if (error is IllegalArgumentException) return error.message ?: "Проверьте введённые данные"
            if (error is HttpException) {
                val body = runCatching { error.response()?.errorBody()?.string() }.getOrNull()
                val serverMessage = runCatching {
                    Gson().fromJson(body, Map::class.java)["error"] as? String
                }.getOrNull()
                return serverMessage ?: when (error.code()) {
                    401 -> "Неверный email или пароль"
                    404 -> "Сервер KinoLike не найден по этому адресу"
                    in 500..599 -> "Сервер KinoLike временно недоступен"
                    else -> "Ошибка сервера (${error.code()})"
                }
            }
            return when (error) {
                is java.net.UnknownHostException -> "Сервер не найден. Проверьте адрес и сеть"
                is java.net.SocketTimeoutException -> "Сервер не ответил вовремя"
                is javax.net.ssl.SSLException -> "Не удалось установить защищённое HTTPS-соединение"
                is java.io.IOException -> "Нет соединения с сервером"
                else -> error.message ?: "Неизвестная ошибка"
            }
        }
    }
}

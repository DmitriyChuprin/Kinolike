package ru.kinolike.tv.data

import android.content.Context
import okhttp3.Cookie
import okhttp3.CookieJar
import okhttp3.HttpUrl

class SessionStore(context: Context) {
    private val preferences = context.getSharedPreferences("kinolike_tv_session", Context.MODE_PRIVATE)

    var serverUrl: String?
        get() = preferences.getString("server_url", null)
        set(value) { preferences.edit().putString("server_url", value).apply() }

    fun clearAll() = preferences.edit().clear().apply()

    inner class PersistentCookieJar : CookieJar {
        override fun saveFromResponse(url: HttpUrl, cookies: List<Cookie>) {
            val token = cookies.lastOrNull { it.name == "token" }
            if (token != null) {
                if (token.expiresAt <= System.currentTimeMillis() || token.value.isEmpty()) {
                    clear()
                } else {
                    preferences.edit()
                        .putString("auth_cookie", token.toString())
                        .putString("auth_cookie_host", url.host)
                        .apply()
                }
            }
        }

        override fun loadForRequest(url: HttpUrl): List<Cookie> {
            if (preferences.getString("auth_cookie_host", null) != url.host) return emptyList()
            val encoded = preferences.getString("auth_cookie", null) ?: return emptyList()
            val cookie = Cookie.parse(url, encoded) ?: run {
                clear()
                return emptyList()
            }
            if (cookie.expiresAt <= System.currentTimeMillis() || !cookie.matches(url)) return emptyList()
            return listOf(cookie)
        }

        fun clear() = preferences.edit().remove("auth_cookie").remove("auth_cookie_host").apply()
    }

    val cookieJar = PersistentCookieJar()
}

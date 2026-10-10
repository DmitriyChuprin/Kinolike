package ru.kinolike.tv.data

import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.POST
import retrofit2.http.Path

interface KinoApi {
    @GET("api/auth/me")
    suspend fun me(): AuthResponse

    @POST("api/auth/login")
    suspend fun login(@Body request: AuthRequest): AuthResponse

    @POST("api/auth/logout")
    suspend fun logout(): Map<String, String>

    @GET("api/tmdb/movie/popular")
    suspend fun popularMovies(): MediaPage

    @GET("api/tmdb/trending/movie/week")
    suspend fun trendingMovies(): MediaPage

    @GET("api/tmdb/trending/tv/week")
    suspend fun trendingTv(): MediaPage

    @GET("api/tmdb/movie/top_rated")
    suspend fun topRatedMovies(): MediaPage

    @GET("api/tmdb/{type}/{id}")
    suspend fun details(@Path("type") type: String, @Path("id") id: Int): MediaItem

    @GET("api/streaming/progress/continue")
    suspend fun continueWatching(): ContinueResponse
}

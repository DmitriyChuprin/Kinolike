package ru.kinolike.tv.data

import com.google.gson.annotations.SerializedName

data class User(
    val id: Long,
    val username: String,
    val email: String,
    @SerializedName("avatar_url") val avatarUrl: String? = null,
)

data class AuthRequest(val email: String, val password: String)
data class AuthResponse(val user: User)

data class MediaPage(
    val results: List<MediaItem> = emptyList(),
    @SerializedName("total_pages") val totalPages: Int = 0,
)

data class Genre(val id: Int, val name: String)

data class Season(
    val id: Int,
    val name: String,
    @SerializedName("season_number") val seasonNumber: Int,
    @SerializedName("episode_count") val episodeCount: Int = 0,
    @SerializedName("poster_path") val posterPath: String? = null,
)

data class MediaItem(
    val id: Int,
    @SerializedName("media_type") val mediaType: String? = null,
    val title: String? = null,
    val name: String? = null,
    @SerializedName("original_title") val originalTitle: String? = null,
    @SerializedName("original_name") val originalName: String? = null,
    val overview: String? = null,
    @SerializedName("poster_path") val posterPath: String? = null,
    @SerializedName("backdrop_path") val backdropPath: String? = null,
    @SerializedName("release_date") val releaseDate: String? = null,
    @SerializedName("first_air_date") val firstAirDate: String? = null,
    @SerializedName("vote_average") val voteAverage: Double = 0.0,
    @SerializedName("vote_count") val voteCount: Int = 0,
    @SerializedName("number_of_seasons") val numberOfSeasons: Int? = null,
    val seasons: List<Season> = emptyList(),
    val genres: List<Genre> = emptyList(),
) {
    val displayTitle: String get() = title ?: name ?: "Без названия"
    val year: String get() = (releaseDate ?: firstAirDate).orEmpty().take(4)

    fun resolvedType(fallback: String? = null): String = when {
        mediaType == "tv" || mediaType == "movie" -> mediaType
        fallback == "tv" || fallback == "movie" -> fallback
        title != null -> "movie"
        else -> "tv"
    } ?: "movie"
}

data class ContinueResponse(val items: List<ContinuePosition> = emptyList())

data class ContinuePosition(
    val tmdbId: Int,
    val mediaType: String,
    val season: Int? = null,
    val episode: Int? = null,
    val position: Double = 0.0,
    val duration: Double = 0.0,
    val translationId: String? = null,
    val updatedAt: String? = null,
)

data class ContinueMedia(val progress: ContinuePosition, val media: MediaItem)

data class HomeRow(val title: String, val items: List<MediaItem>)

data class HomeContent(
    val continueWatching: List<ContinueMedia> = emptyList(),
    val rows: List<HomeRow> = emptyList(),
)

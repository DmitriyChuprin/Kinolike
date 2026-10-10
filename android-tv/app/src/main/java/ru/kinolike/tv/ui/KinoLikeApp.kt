package ru.kinolike.tv.ui

import androidx.activity.compose.BackHandler
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.tv.material3.Button
import androidx.tv.material3.ButtonDefaults
import androidx.tv.material3.Text
import coil3.compose.AsyncImage
import ru.kinolike.tv.R
import ru.kinolike.tv.data.ContinueMedia
import ru.kinolike.tv.data.HomeContent
import ru.kinolike.tv.data.MediaItem
import kotlin.math.roundToInt

@Composable
fun KinoLikeApp(viewModel: MainViewModel) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    Box(Modifier.fillMaxSize().background(KinoBackground)) {
        when (val current = state) {
            ScreenState.Starting -> LoadingScreen("Проверяем подключение…")
            is ScreenState.Server -> ServerScreen(current, viewModel::connect)
            is ScreenState.Login -> LoginScreen(current, viewModel::login, viewModel::changeServer)
            is ScreenState.Home -> HomeScreen(current, viewModel)
            is ScreenState.Details -> DetailsScreen(current, viewModel)
        }
    }
}

@Composable
private fun LoadingScreen(message: String) {
    Column(
        Modifier.fillMaxSize(),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Logo()
        Spacer(Modifier.height(24.dp))
        Text(message, fontSize = 22.sp, color = KinoMuted)
    }
}

@Composable
private fun Logo() {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Image(painterResource(R.drawable.ic_launcher), null, Modifier.size(58.dp))
        Spacer(Modifier.width(14.dp))
        Text("KinoLike", fontSize = 34.sp, fontWeight = FontWeight.Bold)
        Text(" TV", fontSize = 34.sp, color = KinoGold, fontWeight = FontWeight.Bold)
    }
}

@Composable
private fun ServerScreen(state: ScreenState.Server, connect: (String) -> Unit) {
    var server by remember(state.value) { mutableStateOf(state.value) }
    CenterPanel {
        Logo()
        Spacer(Modifier.height(28.dp))
        Text("Подключение к серверу", fontSize = 30.sp, fontWeight = FontWeight.SemiBold)
        Spacer(Modifier.height(8.dp))
        Text("Введите публичный HTTPS-адрес вашего KinoLike", fontSize = 19.sp, color = KinoMuted)
        Spacer(Modifier.height(28.dp))
        TvTextField(
            value = server,
            onValueChange = { server = it },
            label = "https://kinolike.example.ru",
            keyboardType = KeyboardType.Uri,
            onDone = { if (!state.busy) connect(server) },
        )
        ErrorText(state.error)
        Spacer(Modifier.height(18.dp))
        PrimaryButton("${if (state.busy) "Подключаемся…" else "Продолжить"}", !state.busy) { connect(server) }
    }
}

@Composable
private fun LoginScreen(
    state: ScreenState.Login,
    login: (String, String, String) -> Unit,
    changeServer: () -> Unit,
) {
    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    val passwordFocus = remember { FocusRequester() }
    CenterPanel {
        Logo()
        Spacer(Modifier.height(24.dp))
        Text("Вход", fontSize = 30.sp, fontWeight = FontWeight.SemiBold)
        Text(state.serverUrl.removeSuffix("/"), fontSize = 16.sp, color = KinoMuted)
        Spacer(Modifier.height(24.dp))
        TvTextField(email, { email = it }, "Email", KeyboardType.Email, ImeAction.Next) { passwordFocus.requestFocus() }
        Spacer(Modifier.height(14.dp))
        TvTextField(
            password, { password = it }, "Пароль", KeyboardType.Password,
            modifier = Modifier.focusRequester(passwordFocus), password = true,
            onDone = { if (!state.busy) login(state.serverUrl, email, password) },
        )
        ErrorText(state.error)
        Spacer(Modifier.height(18.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            SecondaryButton("Другой сервер", !state.busy, changeServer)
            PrimaryButton(if (state.busy) "Входим…" else "Войти", !state.busy) {
                login(state.serverUrl, email, password)
            }
        }
    }
}

@Composable
private fun CenterPanel(content: @Composable ColumnScope.() -> Unit) {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(
            Modifier.widthIn(max = 680.dp).fillMaxWidth(.55f)
                .clip(RoundedCornerShape(28.dp)).background(KinoSurface).padding(42.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            content = content,
        )
    }
}

@Composable
private fun TvTextField(
    value: String,
    onValueChange: (String) -> Unit,
    label: String,
    keyboardType: KeyboardType,
    imeAction: ImeAction = ImeAction.Done,
    modifier: Modifier = Modifier,
    password: Boolean = false,
    onDone: () -> Unit,
) {
    var focused by remember { mutableStateOf(false) }
    val focusManager = LocalFocusManager.current
    BasicTextField(
        value = value,
        onValueChange = onValueChange,
        singleLine = true,
        textStyle = TextStyle(color = KinoText, fontSize = 21.sp),
        visualTransformation = if (password) PasswordVisualTransformation() else VisualTransformation.None,
        keyboardOptions = KeyboardOptions(keyboardType = keyboardType, imeAction = imeAction),
        keyboardActions = KeyboardActions(
            onNext = { onDone() },
            onDone = { focusManager.clearFocus(); onDone() },
        ),
        modifier = modifier.fillMaxWidth().onFocusChanged { focused = it.isFocused }
            .clip(RoundedCornerShape(12.dp))
            .background(Color(0xFF0D1119))
            .border(if (focused) 3.dp else 1.dp, if (focused) KinoGold else Color(0xFF343946), RoundedCornerShape(12.dp))
            .padding(horizontal = 20.dp, vertical = 18.dp),
        decorationBox = { field ->
            Box {
                if (value.isEmpty()) Text(label, color = KinoMuted, fontSize = 20.sp)
                field()
            }
        },
    )
}

@Composable
private fun ErrorText(error: String?) {
    if (error != null) {
        Spacer(Modifier.height(14.dp))
        Text(error, color = Color(0xFFFF8B82), fontSize = 18.sp)
    }
}

@Composable
private fun PrimaryButton(label: String, enabled: Boolean = true, onClick: () -> Unit) {
    Button(onClick = onClick, enabled = enabled, colors = ButtonDefaults.colors(containerColor = KinoGold)) {
        Text(label, fontSize = 19.sp, color = Color(0xFF201A08), fontWeight = FontWeight.Bold)
    }
}

@Composable
private fun SecondaryButton(label: String, enabled: Boolean = true, onClick: () -> Unit) {
    Button(onClick = onClick, enabled = enabled, colors = ButtonDefaults.colors(containerColor = Color(0xFF303644))) {
        Text(label, fontSize = 19.sp)
    }
}

@Composable
private fun HomeScreen(state: ScreenState.Home, viewModel: MainViewModel) {
    if (state.busy) {
        LoadingScreen("Загружаем каталог…")
        return
    }
    if (state.error != null) {
        ErrorScreen("Каталог временно недоступен", state.error, viewModel::retryHome, viewModel::changeServer)
        return
    }
    val content = state.content ?: HomeContent()
    LazyColumn(
        Modifier.fillMaxSize(),
        contentPadding = PaddingValues(bottom = 48.dp),
        verticalArrangement = Arrangement.spacedBy(26.dp),
    ) {
        item {
            Row(
                Modifier.fillMaxWidth().padding(start = 48.dp, end = 48.dp, top = 28.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Logo()
                Spacer(Modifier.weight(1f))
                Text("${state.user.username}", color = KinoMuted, fontSize = 19.sp)
                Spacer(Modifier.width(18.dp))
                SecondaryButton("Сменить сервер", onClick = viewModel::changeServer)
            }
        }
        if (content.continueWatching.isNotEmpty()) {
            item { ContinueRow(content.continueWatching, viewModel) }
        }
        items(content.rows, key = { it.title }) { row ->
            MediaRow(row.title, row.items, viewModel)
        }
    }
}

@Composable
private fun ContinueRow(items: List<ContinueMedia>, viewModel: MainViewModel) {
    Column {
        SectionTitle("Продолжить просмотр")
        LazyRow(
            contentPadding = PaddingValues(horizontal = 48.dp, vertical = 10.dp),
            horizontalArrangement = Arrangement.spacedBy(20.dp),
        ) {
            items(items, key = { "${it.progress.mediaType}:${it.progress.tmdbId}:${it.progress.season}:${it.progress.episode}" }) { item ->
                ContinueCard(item, viewModel.imageUrl(item.media.backdropPath, "w780")) { viewModel.openDetails(item.media) }
            }
        }
    }
}

@Composable
private fun ContinueCard(item: ContinueMedia, imageUrl: String?, onClick: () -> Unit) {
    var focused by remember { mutableStateOf(false) }
    val scale by animateFloatAsState(if (focused) 1.06f else 1f, label = "continue-focus")
    val percent = if (item.progress.duration > 0) (item.progress.position / item.progress.duration).coerceIn(0.0, 1.0) else 0.0
    Column(
        Modifier.width(310.dp).graphicsLayer { scaleX = scale; scaleY = scale }
            .onFocusChanged { focused = it.isFocused }.focusable().clickable(onClick = onClick),
    ) {
        Box(
            Modifier.fillMaxWidth().height(174.dp).clip(RoundedCornerShape(15.dp))
                .border(if (focused) 4.dp else 0.dp, KinoGold, RoundedCornerShape(15.dp)),
        ) {
            AsyncImage(imageUrl, null, Modifier.fillMaxSize(), contentScale = ContentScale.Crop)
            Box(Modifier.fillMaxSize().background(Brush.verticalGradient(listOf(Color.Transparent, Color(0xCC000000)))))
            Text("▶", Modifier.align(Alignment.Center), fontSize = 34.sp)
            Box(Modifier.align(Alignment.BottomStart).fillMaxWidth().height(6.dp).background(Color(0xFF3C414C))) {
                Box(Modifier.fillMaxWidth(percent.toFloat()).fillMaxHeight().background(KinoGold))
            }
        }
        Spacer(Modifier.height(9.dp))
        Text(item.media.displayTitle, fontSize = 19.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
        val episode = if (item.progress.mediaType == "tv") "S${item.progress.season} · E${item.progress.episode}" else "Фильм"
        Text("$episode · ${(percent * 100).roundToInt()}%", color = KinoMuted, fontSize = 15.sp)
    }
}

@Composable
private fun MediaRow(title: String, items: List<MediaItem>, viewModel: MainViewModel) {
    Column {
        SectionTitle(title)
        if (items.isEmpty()) {
            Text("Ничего не найдено", Modifier.padding(horizontal = 48.dp, vertical = 16.dp), color = KinoMuted, fontSize = 18.sp)
        } else {
            LazyRow(
                contentPadding = PaddingValues(horizontal = 48.dp, vertical = 12.dp),
                horizontalArrangement = Arrangement.spacedBy(20.dp),
            ) {
                items(items.take(20), key = { "${it.resolvedType()}:${it.id}" }) { item ->
                    PosterCard(item, viewModel.imageUrl(item.posterPath)) { viewModel.openDetails(item) }
                }
            }
        }
    }
}

@Composable
private fun SectionTitle(title: String) {
    Text(title, Modifier.padding(horizontal = 48.dp), fontSize = 27.sp, fontWeight = FontWeight.SemiBold)
}

@Composable
private fun PosterCard(item: MediaItem, posterUrl: String?, onClick: () -> Unit) {
    var focused by remember { mutableStateOf(false) }
    val scale by animateFloatAsState(if (focused) 1.08f else 1f, label = "poster-focus")
    Column(
        Modifier.width(180.dp).graphicsLayer { scaleX = scale; scaleY = scale }
            .onFocusChanged { focused = it.isFocused }.focusable().clickable(onClick = onClick),
    ) {
        Box(
            Modifier.width(180.dp).height(270.dp).clip(RoundedCornerShape(16.dp))
                .background(KinoSurface)
                .border(if (focused) 4.dp else 0.dp, KinoGold, RoundedCornerShape(16.dp)),
            contentAlignment = Alignment.Center,
        ) {
            if (posterUrl != null) AsyncImage(posterUrl, item.displayTitle, Modifier.fillMaxSize(), contentScale = ContentScale.Crop)
            else Text("Нет постера", color = KinoMuted, fontSize = 16.sp)
            if (item.voteAverage > 0) {
                Text(
                    "★ %.1f".format(item.voteAverage),
                    Modifier.align(Alignment.TopEnd).padding(8.dp).clip(RoundedCornerShape(8.dp))
                        .background(Color(0xDD11151D)).padding(horizontal = 7.dp, vertical = 4.dp),
                    color = KinoGold, fontSize = 14.sp, fontWeight = FontWeight.Bold,
                )
            }
        }
        Spacer(Modifier.height(9.dp))
        Text(item.displayTitle, fontSize = 18.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text(item.year.ifBlank { if (item.resolvedType() == "tv") "Сериал" else "Фильм" }, color = KinoMuted, fontSize = 15.sp)
    }
}

@Composable
private fun DetailsScreen(state: ScreenState.Details, viewModel: MainViewModel) {
    BackHandler(onBack = viewModel::backToHome)
    val item = state.item ?: state.initial
    Box(Modifier.fillMaxSize()) {
        AsyncImage(
            viewModel.imageUrl(item.backdropPath, "w1280"), null,
            Modifier.fillMaxSize(), contentScale = ContentScale.Crop, alpha = .32f,
        )
        Box(Modifier.fillMaxSize().background(Brush.horizontalGradient(listOf(KinoBackground, KinoBackground.copy(alpha = .88f), KinoBackground.copy(alpha = .45f)))))
        LazyColumn(
            Modifier.fillMaxSize(),
            contentPadding = PaddingValues(48.dp),
            verticalArrangement = Arrangement.spacedBy(20.dp),
        ) {
            item {
                Row(verticalAlignment = Alignment.Top) {
                    AsyncImage(
                        viewModel.imageUrl(item.posterPath), item.displayTitle,
                        Modifier.width(235.dp).height(352.dp).clip(RoundedCornerShape(20.dp)).background(KinoSurface),
                        contentScale = ContentScale.Crop,
                    )
                    Spacer(Modifier.width(40.dp))
                    Column(Modifier.widthIn(max = 760.dp)) {
                        Text(item.displayTitle, fontSize = 44.sp, lineHeight = 50.sp, fontWeight = FontWeight.Bold)
                        Spacer(Modifier.height(12.dp))
                        Text(
                            listOfNotNull(
                                item.year.takeIf { it.isNotBlank() },
                                if (item.voteAverage > 0) "★ %.1f".format(item.voteAverage) else null,
                                item.numberOfSeasons?.let { "$it сез." },
                            ).joinToString("   •   "),
                            fontSize = 21.sp, color = KinoGold,
                        )
                        if (item.genres.isNotEmpty()) {
                            Spacer(Modifier.height(10.dp))
                            Text(item.genres.joinToString(" · ") { it.name }, color = KinoMuted, fontSize = 18.sp)
                        }
                        Spacer(Modifier.height(22.dp))
                        Text(item.overview?.takeIf { it.isNotBlank() } ?: "Описание пока отсутствует", fontSize = 21.sp, lineHeight = 30.sp)
                        Spacer(Modifier.height(24.dp))
                        Row(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                            PrimaryButton("← Назад", onClick = viewModel::backToHome)
                        }
                        if (state.busy) {
                            Spacer(Modifier.height(16.dp)); Text("Загружаем полную информацию…", color = KinoMuted)
                        }
                        ErrorText(state.error)
                    }
                }
            }
            if (item.resolvedType() == "tv" && item.seasons.isNotEmpty()) {
                item { Text("Сезоны", fontSize = 28.sp, fontWeight = FontWeight.SemiBold) }
                item {
                    LazyRow(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        items(item.seasons.filter { it.seasonNumber > 0 }, key = { it.id }) { season ->
                            Box(
                                Modifier.clip(RoundedCornerShape(12.dp)).background(KinoSurface)
                                    .padding(horizontal = 20.dp, vertical = 14.dp),
                            ) {
                                Column {
                                    Text(season.name, fontSize = 18.sp, fontWeight = FontWeight.SemiBold)
                                    Text("${season.episodeCount} серий", fontSize = 15.sp, color = KinoMuted)
                                }
                            }
                        }
                    }
                }
            }
            item {
                Text("Воспроизведение будет добавлено на следующем этапе", color = KinoMuted, fontSize = 17.sp)
            }
        }
    }
}

@Composable
private fun ErrorScreen(title: String, message: String, retry: () -> Unit, changeServer: () -> Unit) {
    CenterPanel {
        Text("!", color = KinoGold, fontSize = 54.sp, fontWeight = FontWeight.Bold)
        Text(title, fontSize = 30.sp, fontWeight = FontWeight.SemiBold)
        Spacer(Modifier.height(10.dp))
        Text(message, color = KinoMuted, fontSize = 19.sp)
        Spacer(Modifier.height(24.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            PrimaryButton("Повторить", onClick = retry)
            SecondaryButton("Сменить сервер", onClick = changeServer)
        }
    }
}

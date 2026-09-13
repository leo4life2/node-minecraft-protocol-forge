package net.neoforged.bus.api;
import java.util.function.Consumer;
public interface IEventBus { <T> void addListener(Consumer<T> listener); }

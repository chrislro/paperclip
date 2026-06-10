"""
Visual Overlay Notification System for EMR Automation.

Provides floating notifications with sound feedback for hotkey actions.
"""

import os
import subprocess
import threading
import time
from pathlib import Path
from typing import Optional

# Try to import tkinter for overlay display
try:
    import tkinter as tk
    TKINTER_AVAILABLE = True
except ImportError:
    tk = None
    TKINTER_AVAILABLE = False


class OverlayNotification:
    """
    Floating overlay notification that appears briefly on screen.
    
    Features:
    - Semi-transparent background
    - Auto-fade after display
    - Color-coded by status (success/warning/error/info)
    - Optional sound feedback
    """
    
    # Status colors (background, text)
    COLORS = {
        'success': ('#1a472a', '#4ade80'),  # Dark green bg, light green text
        'warning': ('#422006', '#fbbf24'),  # Dark orange bg, amber text
        'error': ('#450a0a', '#f87171'),    # Dark red bg, light red text
        'info': ('#1e3a5f', '#60a5fa'),     # Dark blue bg, light blue text
        'recording': ('#3b0764', '#c084fc'), # Dark purple bg, light purple text
    }
    
    # Sound file path (relative to project)
    SOUND_FILE = "zapsplat_multimedia_notification_alert_mallet_musical_sequence_short_positive_005_107275.mp3"
    
    def __init__(self, project_dir: Optional[Path] = None):
        """
        Initialize the overlay notification system.
        
        Args:
            project_dir: Path to project directory (for sound file)
        """
        self.project_dir = project_dir or Path(__file__).parent.parent
        self.sound_path = self.project_dir / self.SOUND_FILE
        self._current_window = None
        self._window_lock = threading.Lock()
        
    def show(
        self, 
        title: str, 
        message: str, 
        status: str = 'info',
        duration: float = 2.5,
        play_sound: bool = True
    ) -> None:
        """
        Show a notification overlay.
        
        Args:
            title: Main title text
            message: Secondary message text
            status: One of 'success', 'warning', 'error', 'info', 'recording'
            duration: How long to show (seconds)
            play_sound: Whether to play notification sound
        """
        if not TKINTER_AVAILABLE:
            # Fallback to console output
            emoji = {'success': '✅', 'warning': '⚠️', 'error': '❌', 'info': 'ℹ️', 'recording': '🎙️'}.get(status, 'ℹ️')
            print(f"{emoji} {title}: {message}")
            return
        
        # Play sound in background if requested
        if play_sound and status != 'recording':
            threading.Thread(target=self._play_sound, daemon=True).start()
        
        # Show overlay in a separate thread to avoid blocking
        threading.Thread(
            target=self._show_overlay,
            args=(title, message, status, duration),
            daemon=True
        ).start()
    
    def _show_overlay(self, title: str, message: str, status: str, duration: float) -> None:
        """Display the overlay window (runs in separate thread)."""
        try:
            # Create a new Tk root for this thread
            root = tk.Tk()
            
            # Configure window as an overlay
            root.overrideredirect(True)  # No window decorations
            root.attributes('-topmost', True)  # Always on top
            root.attributes('-alpha', 0.92)  # Slightly transparent
            
            # Try to make it a proper overlay on macOS
            try:
                root.attributes('-type', 'notification')  # Some WMs support this
            except Exception:
                pass
            
            # Colors
            bg_color, text_color = self.COLORS.get(status, self.COLORS['info'])
            
            # Configure the root window
            root.configure(bg=bg_color)
            
            # Main container with padding and rounded appearance
            frame = tk.Frame(root, bg=bg_color, padx=20, pady=15)
            frame.pack(fill='both', expand=True)
            
            # Emoji based on status
            emoji = {
                'success': '✅',
                'warning': '⚠️', 
                'error': '❌',
                'info': 'ℹ️',
                'recording': '🎙️'
            }.get(status, 'ℹ️')
            
            # Title with emoji
            title_label = tk.Label(
                frame,
                text=f"{emoji}  {title}",
                font=('SF Pro Display', 18, 'bold'),  # macOS system font
                fg=text_color,
                bg=bg_color
            )
            title_label.pack(anchor='w')
            
            # Message
            if message:
                msg_label = tk.Label(
                    frame,
                    text=message,
                    font=('SF Pro Text', 14),
                    fg=self._adjust_brightness(text_color, 0.7),
                    bg=bg_color,
                    wraplength=350
                )
                msg_label.pack(anchor='w', pady=(5, 0))
            
            # Calculate position (bottom-right of screen)
            root.update_idletasks()
            width = root.winfo_reqwidth()
            height = root.winfo_reqheight()
            screen_width = root.winfo_screenwidth()
            screen_height = root.winfo_screenheight()
            
            x = screen_width - width - 20
            y = screen_height - height - 80  # Above dock on macOS
            
            root.geometry(f'+{x}+{y}')
            
            # Schedule auto-close
            root.after(int(duration * 1000), root.destroy)
            
            # Run the main loop for this overlay
            root.mainloop()
            
        except Exception as e:
            # Fallback to console if overlay fails
            print(f"[{status.upper()}] {title}: {message}")
    
    def _adjust_brightness(self, hex_color: str, factor: float) -> str:
        """Adjust the brightness of a hex color."""
        try:
            hex_color = hex_color.lstrip('#')
            r = int(int(hex_color[0:2], 16) * factor)
            g = int(int(hex_color[2:4], 16) * factor)
            b = int(int(hex_color[4:6], 16) * factor)
            return f'#{r:02x}{g:02x}{b:02x}'
        except Exception:
            return hex_color
    
    def _play_sound(self) -> None:
        """Play the notification sound (macOS)."""
        try:
            if self.sound_path.exists():
                subprocess.Popen(
                    ['afplay', str(self.sound_path)],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL
                )
            else:
                # Fallback to system sound
                subprocess.Popen(
                    ['afplay', '/System/Library/Sounds/Glass.aiff'],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL
                )
        except Exception:
            pass  # Sound is optional


# Global singleton for easy access
_overlay: Optional[OverlayNotification] = None


def get_overlay(project_dir: Optional[Path] = None) -> OverlayNotification:
    """Get or create the global overlay instance."""
    global _overlay
    if _overlay is None:
        _overlay = OverlayNotification(project_dir)
    return _overlay


def notify(
    title: str,
    message: str = "",
    status: str = 'info',
    duration: float = 2.5,
    play_sound: bool = True
) -> None:
    """
    Convenience function to show a notification.
    
    Args:
        title: Main title text
        message: Secondary message text  
        status: One of 'success', 'warning', 'error', 'info', 'recording'
        duration: How long to show (seconds)
        play_sound: Whether to play notification sound
    """
    get_overlay().show(title, message, status, duration, play_sound)


# Quick status functions
def success(title: str, message: str = "", duration: float = 2.0) -> None:
    """Show success notification."""
    notify(title, message, 'success', duration)


def warning(title: str, message: str = "", duration: float = 3.0) -> None:
    """Show warning notification."""
    notify(title, message, 'warning', duration)


def error(title: str, message: str = "", duration: float = 4.0) -> None:
    """Show error notification."""
    notify(title, message, 'error', duration)


def info(title: str, message: str = "", duration: float = 2.5) -> None:
    """Show info notification."""
    notify(title, message, 'info', duration)


def recording(title: str, message: str = "", duration: float = 2.0) -> None:
    """Show recording notification (no sound)."""
    notify(title, message, 'recording', duration, play_sound=False)


if __name__ == '__main__':
    # Demo all notification types
    print("Testing overlay notifications...")
    
    success("Gastroenterite 1", "Prescrição impressa para João, 8kg")
    time.sleep(3)
    
    warning("Atenção", "Nenhum paciente selecionado")
    time.sleep(3)
    
    error("Erro", "Falha ao processar alta")
    time.sleep(3)
    
    info("Atualizado", "Peso: 12kg | Queixa: Febre")
    time.sleep(3)
    
    recording("Gravando", "Ctrl+Alt+A para parar")
    time.sleep(3)
    
    print("Done!")

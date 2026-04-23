# VHS demo tape for atropos. Generates assets/demo.gif.
# Run: vhs assets/demo.tape

Output assets/demo.gif

Set Shell bash
Set FontSize 16
Set Width 1080
Set Height 720
Set Theme "Dracula"
Set TypingSpeed 60ms
Set PlaybackSpeed 1.0

# --- Hidden setup: build the messy demo repo ---
Hide
Type "bash /Users/siddharthnigam/Desktop/Atropos/assets/demo-setup.sh /tmp/atropos-demo"
Enter
Sleep 1s
Type "cd /tmp/atropos-demo"
Enter
Type "clear"
Enter
Sleep 500ms
Show

# --- The mess ---
Type "git log --oneline"
Enter
Sleep 3500ms

Type "clear"
Enter
Sleep 300ms

# --- Plan ---
Type "atropos"
Enter
Sleep 2500ms

Type "head -28 .atropos/plan.md"
Enter
Sleep 4500ms

Type "clear"
Enter
Sleep 300ms

# --- Apply ---
Type "atropos apply"
Enter
Sleep 2500ms

# --- The clean result ---
Type "git log --oneline"
Enter
Sleep 4000ms

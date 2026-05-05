"use client"

import * as React from "react"
import { cn } from "@/lib/utils"

// Context to pass image load status to AvatarFallback
interface AvatarContextValue {
  imageLoaded: boolean
  imageError: boolean
  setImageLoaded: (v: boolean) => void
  setImageError: (v: boolean) => void
}

const AvatarContext = React.createContext<AvatarContextValue>({
  imageLoaded: false,
  imageError: false,
  setImageLoaded: () => {},
  setImageError: () => {},
})

const Avatar = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, children, ...props }, ref) => {
    const [imageLoaded, setImageLoaded] = React.useState(false)
    const [imageError, setImageError] = React.useState(false)

    return (
      <AvatarContext.Provider value={{ imageLoaded, imageError, setImageLoaded, setImageError }}>
        <div
          ref={ref}
          className={cn(
            "relative flex h-10 w-10 shrink-0 overflow-hidden rounded-full",
            className
          )}
          {...props}
        >
          {children}
        </div>
      </AvatarContext.Provider>
    )
  }
)
Avatar.displayName = "Avatar"

type AvatarImageProps = React.ImgHTMLAttributes<HTMLImageElement>;

const AvatarImage = React.forwardRef<HTMLImageElement, AvatarImageProps>(
  ({ className, src, alt = "", onLoad, onError, ...props }, ref) => {
    const { setImageLoaded, setImageError } = React.useContext(AvatarContext)

    return (
      <img
        ref={ref}
        src={src}
        alt={alt}
        className={cn("aspect-square h-full w-full object-cover", className)}
        onLoad={(e) => {
          setImageLoaded(true)
          setImageError(false)
          onLoad?.(e)
        }}
        onError={(e) => {
          setImageError(true)
          setImageLoaded(false)
          onError?.(e)
        }}
        {...props}
      />
    )
  }
)
AvatarImage.displayName = "AvatarImage"

const AvatarFallback = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, children, ...props }, ref) => {
  const { imageLoaded, imageError } = React.useContext(AvatarContext)

  // Show fallback if image hasn't loaded or has errored
  // Also show while waiting (neither loaded nor errored yet)
  if (imageLoaded && !imageError) return null

  return (
    <div
      ref={ref}
      className={cn(
        "flex h-full w-full items-center justify-center rounded-full bg-muted",
        className
      )}
      {...props}
    >
      {children}
    </div>
  )
})
AvatarFallback.displayName = "AvatarFallback"

export { Avatar, AvatarImage, AvatarFallback }
